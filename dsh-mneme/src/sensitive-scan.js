// #164 A2：写入边界的密钥 / PII 判据。判据来源是 #164 A2（维护者 09-28 把认领转给
// 本侧），消费方是 #254 的写入准入——`write-admission.js` 从 #332 起就留了
// `sensitiveScan` 注入点，本模块是那个占位的实现。
//
// 为什么判据独立成文件、不写进 write-admission.js：判据的归属是 #164 A2，闸门的归属
// 是 #254。闸门只消费 `{kind, label}`（deny 面已在 #332 定死），判据自己既不认识
// 「会话预算」也不认识 `llm_audit_logs`——换一个判据（比如将来接更重的 PII 分类器）
// 只换注入的那一行。写入边界的另外两个出口（autoSummarize / dream 输出）要复用同一份
// 判据时也直接 import 本模块的 `scanSensitive`，不必各写一套形状。
//
// 三条判据口径（前两条是 #254 已定的硬约束，第三条是本模块自己的）：
//
// 1. 零 LLM、纯确定性。写入路径在最上游，这里多花的时间会乘上每一次写入；EdgeMem
//    （2609.05553）那句「能不用模型判定就不用」说的就是这一层。
//
// 2. 假阳率由负样本定。`test/helpers/write-admission-samples.js` 的 12 条负样本是
//    #332 就配好的验收面，维护者把话说死了：「同一套负样本原样跑，抓错任何一条就不
//    算落地」。所以本模块的形状是**先认形状再认关键词**——纯关键词匹配在那组负样本
//    上全军覆没（「把 API key 放进环境变量」这类讨论句里一个凭据值都没有）。
//
// 3. 报最严重的那一类（`kind` 落审计）。同一个字符串可能同时像两类（`sk_live_` 前缀
//    既是 Stripe 的形状、也能被通用的 `sk-` 规则吃下），所以规则表按「越具体越靠前」
//    排，命中即返回。密钥在前、PII 在后：两者误杀面差一个量级（密钥串出现在正常项目
//    记忆里就是事故，邮箱 / 手机号完全可能是正当内容），同时命中时报更严重的那一类。
//    `kind` 是稳定判据键（不是展示文案），enforce 打开前先按它看分布，将来要按类放行
//    也只改策略、不动判据。
//
// 已知边界（都是「宁漏不误杀」的取舍，不是遗漏）：
//   - 只扫文本（title / content / tags）。不扫路径、id、时间戳这类元数据字段——它们
//     由系统生成，不是用户写进来的内容，扫它们只会引入假阳。
//   - 中文关键词（密码 / 令牌）不认。补进去会让「密码必须脱敏后再入库」这类讨论句
//     命中，而那正是负样本 group 的形状。要覆盖中文赋值得先设计「关键词语种 × 值形状」
//     的两维判据，不在本批。
//   - 手机号只认大陆移动号段（1[3-9] + 9 位），固定电话与带国家码的写法不认。宽一位
//     就会把长度相近的订单号 / 内部编号吃进来，而 PII 这一档的误杀面已经比密钥大一档。
//   - 银行卡号加 Luhn 校验：`0000000000000000`、`4111111111111112` 这类形状对但校验
//     不过的串不报。少了这道校验，任何 16 位数字串（订单号、时间戳拼接）都会命中。
//   - 身份证同样加校验位（GB 11643 / ISO 7064 MOD 11-2）：位数对但校验不过的 18 位
//     数字串不报。原先只有银行卡有校验、身份证没有，结果是 18 位纯数字先被身份证规则
//     命中，反倒绕过银行卡那条的 Luhn。
//
// 归一化：这里**不**用 content-hash.js 的 normalizeForHash。那套口径（NFKC → 小写 →
// 去标点）是为「只差格式的两条写入是否同一件事」定的，判据要的是原串的形状——大小写
// 是密钥 alphabet 的一部分（`AKIA` 与 `akia` 不是同一个值），去掉 `-` / `_` 会把 JWT
// 与 Slack token 的分段结构一起折没。两个口径别互换。

/** 判据命中的返回形状（与 `createWriteAdmission` 的 sensitiveScan 契约一致）。 */
// kind 是稳定键、label 是给人看的一行说明；两者都落 llm_audit_logs 的
// metadata.deny，所以别在其中塞运行时的值（命中的凭据本身绝不落盘 / 不回显）。
const SECRET_RULES = [
  { kind: "aws_access_key", label: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  // AWS 的 secret access key 没有前缀，只能靠赋值键认：`AWS_SECRET_ACCESS_KEY` /
  // `aws_secret_access_key` 这个键名是它的形状。最早的一批 `secret` 关键词规则被
  // 「必须在赋值号前」的位置要求挡在外面（多词键里 `secret` 后面跟的是 `_`，不是
  // `:`/`=`），所以它得单独一条。40 位下限取 AWS 官方密钥的固定长度。
  {
    kind: "aws_secret_key",
    label: "AWS secret access key",
    // 键名不分大小写，所以挂 `/i` 而不是行内修饰符组 `(?i:...)`：后者是 ES2025 语法，
    // CI 矩阵里的 Node 22 直接抛 SyntaxError（本文件其余规则也没有用它的）。
    // 值那一半本来就是 `[A-Za-z0-9/+=]`，带上 `/i` 不改变大小写敏感度。
    re: /(?:aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i
  },
  { kind: "github_token", label: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { kind: "slack_token", label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  // PEM 头是明文私钥的确定标志，带不带正文都一样判——`BEGIN` 与 `PRIVATE KEY` 之间
  // 可能有 `RSA` / `EC` / `OPENSSH`，所以中间那段是 [A-Z ]*。
  { kind: "private_key", label: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "jwt", label: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  // scheme 与 userinfo 两段都加上界。scheme 那段的 `*` 作用在含 `.` 的字符类上，
  // 一条长点分串（包名 / 路径 / 版本链）里每个起点都要一路回溯到结尾才发现没有
  // `://` → 与 email 同源的 O(n²)（实测 120KB 对抗串里这条占 4.1 秒）。
  // URL scheme 名本就短、`user:password` 也不会长到 64，上界只钉住回溯面，
  // 真实连接串一条不少。
  { kind: "connection_string", label: "credentials in URL", re: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,64}:[^\s/:@]{6,}@/ },
  // Stripe 排在通用 `sk-` 之前：`sk_live_…` 两条规则都吃，先到的那条决定 kind。
  // 只认 sk_live_（生产密钥）：sk_test_ 是公开测试密钥，报它是纯误杀。
  { kind: "stripe_key", label: "Stripe secret key", re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { kind: "npm_token", label: "npm auth token", re: /_authToken\s*=\s*[A-Za-z0-9_-]{20,}/ },
  // 下限 24 而不是 20：这是一条纯收紧、不动语料读数的加固——OpenAI 的 key 没有校验
  // 位，前缀 + 长度是唯一形状，20 位会把更长的假阳性面留在表里。`sk-` 后面跟短串的
  // 赋值句仍会被赋值型那条认下（那是**对的**：值长了 8 位以上就该报）。
  { kind: "openai_key", label: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/ },
  {
    // 赋值型：最常见的一类，也是负样本组（占位符 / 环境变量 / 模板变量 / 只提关键词）
    // 的主要靶子。判据是「关键词 + 赋值号 + 右边真的是个值的形状」，值本身不校验
    // alphabet——凭据值没有通用形状，能通用的只有「它不像占位符」。
    kind: "assigned_secret",
    label: "assigned credential literal",
    // 左边界不能把 `_` 排除在外：环境变量名正是拿 `_` 当分隔符，排除它会让
    // `DB_PASSWORD=` / `MY_API_KEY=` / `MYSQL_PASSWORD=` 整类漏放（只有恰好落在
    // 行首的 `API_KEY=` 能中）。放宽后 #332 那套 26 条语料（含 12 条负样本）全绿，
    // 说明原写法不是语料换来的取舍。挡误杀的是下面那道占位符守卫，不是这个边界。
    re: /(?:^|[^A-Za-z0-9])(?:password|passwd|pwd|secret|api[_-]?key|token)\b\s*[:=]\s*["']?([^\s"']{8,})/i,
    // 占位符守卫：右边是尖括号占位、shell / 模板变量、环境变量读取、或一串 x / * / …
    // 时不算命中。少这道守卫，`password: <redacted>` 与 `token: ${TOKEN}` 都会被报，
    // 而它们正是「配置里该怎么写」的示例文本。
    guard: (value) => !/^(?:<[^>]*>|\$\{|\$[A-Z_]+$|process\.env|redacted|xx+|\*+|\u2026)/i.test(value)
  }
];

const PII_RULES = [
  {
    kind: "email",
    label: "email address",
    // 先看 TLD 再看 `@`：反过来的 `(?:[A-Za-z]{2,}\.)+[A-Za-z]{2,}` 对
    // `a@b.c.d.e` 这类可以回溯出指数条路径。
    // local part 的 `+` 必须加上界。该字符类含 `.`，所以一条长点分串（包名 / 路径 /
    // 版本链）后跟一个 `@` 时，每个起点都要重扫到那个 `@` 才失败 → 整体 O(n²)。
    // 实测 120KB 对抗串 23.5 秒里这条占 18.6 秒，34KB 点分链要 0.6 秒；本判据在写入
    // 路径上同步跑，等于把写入阻塞住。64 是 RFC 5321 给 local part 的上限，加上界
    // 不缩检测面——放弃的只是长于 64 的非法形状。
    re: /\b[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/
  },
  { kind: "cn_mobile", label: "mainland mobile number", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { kind: "cn_id_card", label: "mainland ID number", re: /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/, cnId: true },
  { kind: "bank_card", label: "payment card number", re: /(?<!\d)(?:\d{13,19})(?!\d)/, luhn: true }
];

/**
 * Luhn（模 10）校验。银行卡号这一档只靠位数与首字符形状会把所有 13–19 位数字串
 * 都吃进来，而项目记忆里长度差不多的数字串（订单号、拼接的时间戳）很常见；校验位
 * 是卡号自带的、零成本的第二道形状。负样本里没有卡号形状的串，这道校验是防未列举
 * 的那一类（同时它也不影响正样本：4111111111111111 是 Luhn 通过的公开测试卡号）。
 * @param {string} value 归一后的数字串（可能含分隔符）
 */
function passesLuhn(value) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// 大陆身份证校验位（GB 11643 / ISO 7064 MOD 11-2）。与银行卡的 Luhn 同理：18 位
// 数字串在项目记忆里很常见（订单号、内部编号、拼接时间戳），位数这个形状拦不住它们，
// 而校验位是身份证自带的、零成本的第二道形状。权重序列与余数映射都是标准值，别改。
const CN_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CN_ID_CODES = "10X98765432";
/** @param {string} value 命中串（17 位数字 + 校验位，校验位可为 X） */
function passesCnId(value) {
  if (!/^\d{17}[\dXx]$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(value[i]) * CN_ID_WEIGHTS[i];
  return CN_ID_CODES[sum % 11] === value[17].toUpperCase();
}

/**
 * 扫一段文本里的密钥 / PII。命中返回 `{kind, label}`、未命中返回 null，不抛。
 *
 * 只认第一处命中（按规则表顺序 = 严重度顺序）。一次写入里出现第二条凭据时不再报——
 * deny 面只记判据类别，报多条只是把同一件事写几遍。
 * @param {unknown} value
 * @returns {{kind: string, label: string}|null}
 */
export function scanSensitive(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (!text) return null;
  for (const rule of [...SECRET_RULES, ...PII_RULES]) {
    const match = text.match(rule.re);
    if (!match) continue;
    // 守卫只看捕获组：没有捕获组的规则天然没有守卫。
    if (rule.guard && !rule.guard(match[1] ?? "")) continue;
    if (rule.luhn && !passesLuhn(match[0])) continue;
    if (rule.cnId && !passesCnId(match[0])) continue;
    return { kind: rule.kind, label: rule.label };
  }
  return null;
}

/**
 * 判据的两种调用面，共用同一份规则表：
 *   `scanSensitive(text)`           — 任意文本，给写入边界之外的消费方（autoSummarize /
 *                                     dream 输出）直接调；它们手里是文本，不是记忆行。
 *   `createSensitiveScan({config})` — `write-admission.js` 的 `sensitiveScan` 契约，
 *                                     入参是记忆对象、返回 `{kind, label}` 或 null。
 *
 * 开关在工厂里判一次：`sensitiveScanEnabled` 关时返回 null，闸门侧连函数都拿不到，
 * 于是「第 1 级只跑空白 / 噪声」这条路与 #332 合并时**逐字段一致**（那一版根本没有
 * 这个函数）。反过来，本键开着也不会自己去扫：唯一的调用点是闸门的 firstLevelHit，
 * 而闸门要 `writeAdmission.enabled` 打开才走第 1 级判据。所以两个键是「闸门」与
 * 「闸门内这一批判据」的关系，不是互为子开关——任一个关着，A2 都不产生任何判定。
 * 分成两个键是为了能单独观察 A2 的命中分布（空白 / 噪声与密钥 / PII 的误杀面差一个
 * 量级），不是为了让它能脱离闸门独立生效。
 *
 * @param {{config?: object}} [deps]
 * @returns {((memory: object) => ({kind: string, label: string}|null))|null}
 */
export function createSensitiveScan({ config } = {}) {
  if (config?.sensitiveScanEnabled !== true) return null;
  const scan = (memory) => {
    const text = [memory?.title, memory?.content, ...(Array.isArray(memory?.tags) ? memory.tags : [])]
      .filter((s) => typeof s === "string")
      .join("\n");
    return scanSensitive(text);
  };
  // 工厂只认「开 / 关」；enforce 由 write-admission 决定（命中即 deny 还是仅告警），
  // 判据自己不碰决策——那一步在闸门里。两层分开就能先开检测看分布、再开拦截。
  return scan;
}
