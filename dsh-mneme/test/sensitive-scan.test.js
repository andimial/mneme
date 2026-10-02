// #164 A2：写入边界的密钥 / PII 判据（src/sensitive-scan.js）。
//
// 这是「真判据」自己的验收，与 write-admission.test.js 里那组（拿参考扫描器测**闸门
// 接线**）分工不同：这边测判据本身，且第一条用例就是把 #332 配好的 26 条语料原样跑在
// 生产实现上——维护者 09-28 的验收条件就是这句「同一套负样本原样跑，抓错任何一条就
// 不算落地」，所以它放在这里而不是再抄一份语料。
//
// 参考扫描器 referenceScan 只服务闸门测；本文件刻意**不** import 它——生产判据与
// 参考实现是两份独立实现，同时跑过同一套语料才算把语料用足（对照着改就成了自证）。
import test from "node:test";
import assert from "node:assert/strict";

import { scanSensitive, createSensitiveScan } from "../src/sensitive-scan.js";
import {
  SECRET_SAMPLES,
  PII_SAMPLES,
  POSITIVE_SAMPLES,
  NEGATIVE_SAMPLES,
  SAMPLE_VALUES
} from "./helpers/write-admission-samples.js";

// #164 A2 的语料里那几条凭据值走 helper 的拼接导出，别在测试里另抄一份字面量：
// GitHub 的 push protection 会按形状拦真实凭据（本 PR 实测：`sk_live_` 一条就够
// 拒推，helper 正是为这件事把值拆成两段拼的）。这里复用同一份，仓库文本里不留完整形状。
const STRIPE_KEY = SAMPLE_VALUES.stripeKey;

// 正样本那条 OpenAI key 从语料里取，不另抄字面量（同 STRIPE_KEY 的理由）。
const OPENAI_KEY = POSITIVE_SAMPLES.find((s) => s.id === "openai-key").content.match(/\S*sk-\S+/)[0];
/** `sk-proj-…` 前缀的变体：语料那条不带 proj-，这里补同样的正文长度。 */
const openaiProjKey = (body) => `sk-proj-${body}`;
const OPENAI_BODY = OPENAI_KEY.replace(/^.*?sk-(?:proj-)?/, "");

test("真判据：正样本一条都不漏放，且 kind 与语料声明一致", () => {
  for (const sample of POSITIVE_SAMPLES) {
    const text = `${sample.title}\n${sample.content}`;
    const hit = scanSensitive(text);
    assert.ok(hit, `${sample.id} 被漏放（${sample.why}）`);
    // kind 是审计行里的稳定判据键：它错了，「按 kind 看命中分布」这条路就断了。
    // 同一个串可能被多条规则吃下（`sk_live_` 也像通用 `sk-`），所以顺序是判据的一部分。
    assert.equal(hit.kind, sample.kind, `${sample.id} 的 kind 必须是语料声明的那个（规则顺序变了就会漂）`);
    assert.equal(typeof hit.label, "string");
  }
});

test("真判据：负样本一条都不误杀（抓错任何一条就不算落地）", () => {
  for (const sample of NEGATIVE_SAMPLES) {
    const hit = scanSensitive(`${sample.title}\n${sample.content}`);
    assert.equal(hit, null, `${sample.id} 被误杀（${sample.why}）：实际命中 ${hit?.kind}`);
  }
});

test("密钥与 PII 分两档，但都从同一条通道出来", () => {
  // 分档的意义是「将来按类放行只改策略、不动判据」：kind 集合是策略的抓手，
  // 所以这里断言两类都能被分辨，而不是把 PII 折进密钥那一档。
  assert.ok(SECRET_SAMPLES.length >= 1 && PII_SAMPLES.length >= 1);
  assert.equal(scanSensitive("password = \"Tr0ub4dor&3xKcd\"").kind, "assigned_secret");
  assert.equal(scanSensitive("联系方式 zhang.wei@example.com").kind, "email");
  assert.equal(scanSensitive("值班手机 13800138000").kind, "cn_mobile");
});

test("只扫文本：路径与 id 这类元数据字段不进判据", () => {
  // 元数据由系统生成，不是用户写进来的内容；扫它们只会引入假阳（一个文件名里
  // `token` 这种词很常见）。契约是判据只看记忆的文本字段。
  const scan = createSensitiveScan({ config: { sensitiveScanEnabled: true } });
  assert.equal(scan({ title: "配置", content: "正常正文", id: SAMPLE_VALUES.githubPat, doc_path: STRIPE_KEY }), null);
  // 反过来，正文里的凭据必须报——上面那条不是靠「什么都扫不到」通过的。
  assert.ok(scan({ title: "配置", content: `正文里有 ${SAMPLE_VALUES.githubPat}` }));
});

test("tags 也扫：标签是用户输入的自由文本", () => {
  const scan = createSensitiveScan({ config: { sensitiveScanEnabled: true } });
  assert.equal(scan({ title: "正常标题", content: "正常正文", tags: ["正常"] }), null);
  assert.equal(scan({ title: "正常标题", content: "正常正文", tags: [SAMPLE_VALUES.githubPat] })?.kind, "github_token");
});

test("工厂：判据自己的闸关时连函数都不给（闸门侧行为与 #332 逐字段一致）", () => {
  assert.equal(createSensitiveScan({ config: { sensitiveScanEnabled: false } }), null);
  assert.equal(createSensitiveScan({ config: {} }), null);
  assert.equal(createSensitiveScan({}), null, "没有 config 也不能默认开");
  assert.equal(createSensitiveScan({ config: { sensitiveScanEnabled: "true" } }), null, "字符串 true 不是 true");
  const scan = createSensitiveScan({ config: { sensitiveScanEnabled: true } });
  assert.equal(typeof scan, "function");
});

test("工厂不碰决策：命中只报 kind，拦不拦由闸门的 enforce 决定", () => {
  // 判据与闸门分层（#164：默认仅告警、拦截 opt-in）——判据知道「这是什么」，
  // 但不知道也不该知道「要不要拦」。返回值里没有 decision / enforced 这类字段，
  // 就是这条分层的机器可判点。
  const scan = createSensitiveScan({
    config: { sensitiveScanEnabled: true, writeAdmission: { enabled: true, enforce: false } }
  });
  const hit = scan({ title: "调试", content: openaiProjKey(OPENAI_BODY) });
  assert.deepEqual(Object.keys(hit).sort(), ["kind", "label"]);
});

test("不抛：坏输入返回 null，扫描器故障不会把写入变成不可用", () => {
  assert.equal(scanSensitive(undefined), null);
  assert.equal(scanSensitive(null), null);
  assert.equal(scanSensitive(""), null);
  assert.equal(scanSensitive(12345), null);
  const scan = createSensitiveScan({ config: { sensitiveScanEnabled: true } });
  assert.equal(scan(null), null);
  assert.equal(scan({ title: 7, content: null, tags: "not-an-array" }), null);
});

test("一处命中只报最严重的那条（deny 面记类别，不记条数）", () => {
  // 一篇同时带 Stripe 密钥与邮箱的正文：报密钥那一档。反过来把 PII 排在前面
  // 会让「这条命中过密钥」这个更严重的事实被邮箱盖掉。
  const text = `邮箱 a@b.com，另外 ${STRIPE_KEY}`;
  assert.equal(scanSensitive(text).kind, "stripe_key");
});

test("语料之外的探针：漏放那一类锁一条（实现期实测出来的，不是假想）", () => {
  // 不在 #332 的 26 条语料里，是拿真判据跑额外形状时发现的：AWS secret access key
  // 没有前缀，`secret` 关键词规则又要求它后面紧跟赋值号，多词键
  // （`AWS_SECRET_ACCESS_KEY=`）两条都够不着 → 补了专用的键名规则。
  assert.equal(
    scanSensitive("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY").kind,
    "aws_secret_key"
  );
  // 反向确认「值 + 赋值键」这条兜底规则还在工作，而且**不**看值的形状：`api_key =`
  // 后面跟任何 8 位以上的值都报（判据不知道哪个值是真的）。
  assert.equal(scanSensitive("api_key = sk-abcdefghijklmnopqrst").kind, "assigned_secret");
  // 收紧后的开关键字仍然认 24 位以上的真 key（44 位正文，语料那条）。
  assert.equal(scanSensitive(openaiProjKey(OPENAI_BODY)).kind, "openai_key");
});
