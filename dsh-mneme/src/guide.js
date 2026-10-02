// #249（第一批）：能力说明——写给模型的「怎么用这套记忆」，不是给用户的文案。
//
// 为什么英文、且只留一份正本：注入指引的参照实现全部用英文（ACP 的
// ACP_SYSTEM_PROMPT + HOW_TO_COMPRESS_RULES、mnemon 的 ROUTING_GUIDANCE、
// 宿主压缩摘要规则），仓库既有先例也是 src/tools.js 的工具描述硬编码英文。
// src/lang.js 的 memory.language 管的是「生成出来的记忆内容与块内标题」，与本
// 模块是两件事，故不并入 STR、不做 zh/en 双写（双写只会让两份文本日后漂移）。
//
// 两个承载位（#249 §5）：①工具描述——常驻、零注入成本，放「何时用这个工具」
// 这类单工具指引（TOOL_GUIDE）；②系统提示段 order 150——放工具描述装不下的
// 总则（优先序、何时查 / 何时写 / 何时 no-op）。该段必须同会话内稳定，否则
// 每轮变化会作废其后的前缀缓存，因此这里全是常量，不含任何运行时插值。
//
// 前缀 `[dsh-mneme memory]` 是机械校验用的：测试按它断言「只在开时出现、且不
// 逐轮复读」，也让维护者能一眼认出这段文本的归属。

const SECTION_LINES = [
  "[dsh-mneme memory] Read once; it applies to every turn of this session.",
  "1. Precedence: the current instruction and the repository's actual state outrank any stored memory. " +
    "When a memory contradicts either, check the instruction or the repository itself before relying on it — memory_search " +
    "searches stored memories only, so it finds earlier context, never the present state. Never treat an old memory as current fact.",
  "2. Recall on demand: call memory_search when the task depends on earlier decisions, user preferences, or project history " +
    "that is not already in context. Do not search for facts you can read directly from the repository.",
  "3. Write back sparingly: use memory_save for durable, cross-session value — a preference, a decision with its rationale, " +
    "an engineering constraint, a pitfall with its root cause. Trivial single-turn work is not worth a memory.",
  "4. When unsure, do nothing. Not acting is a valid outcome: a useless memory is paid for by every future session.",
  "5. Prefer the reversible tools. memory_archive hides an entry from lists, search, injection and consolidation, and " +
    "memory_forget suppresses it from injection, search results and lists — both are recoverable. memory_delete is permanent, " +
    "so reach for it only when an entry is wrong or unwanted, not merely stale."
];

/** 系统提示段（order 150）的总则文本。常量：同会话内稳定是硬约束。 */
export const MEMORY_GUIDE_SECTION = SECTION_LINES.join("\n");

/** 单工具判断指引，追加到对应工具描述尾部（`injectGuidanceEnabled` 开启时）。 */
export const TOOL_GUIDE = {
  memory_search:
    " Use this when the task depends on earlier decisions, preferences, or project history that is not already in context, " +
    "or to look for a newer memory behind one that seems stale. " +
    "Skip it for facts you can read directly from the repository.",
  // 第二句（#249 第二批：「能力说明里没提 scope」）：TOOL_GUIDE.memory_save 此前只
  // 讲「该不该写」，没讲「写给谁看」——而 memory_save 的 scope 参数是**必填面**，
  // 漏填的后果是单向的。所以这里给的是一条判断规则而不是一句免责声明：不确定就别填
  // （未标注 = 处处可见，NULL 恒可见，是安全的默认）；标了 scope 才在多 scope 检索里
  // 付出代价。那句代价必须按实写：A2 软隔离是「他 scope 降权 ×0.5 但保留可见」
  // （service.js），只有 A3 `strictScope`（默认关）才真的硬过滤。写「静默消失」既不
  // 符合默认配置下的行为，也撞上「拒绝可解释、不静默丢弃」的口径（#254 验收第 2 条），
  // 会让模型以为标注有它实际没有的隐私效果。
  // 写进工具描述而不是总则：它是 memory_save 单工具的判据，总则那五条讲的是
  // 「何时查 / 何时写 / 何时 no-op」，加第六条会把单工具语义抬成全局纪律。
  memory_save:
    " Save only durable, cross-session value (a preference, a decision with its rationale, an engineering constraint, " +
    "a pitfall with its root cause). Trivial single-turn work does not belong here, and when unsure, do not save. " +
    "If a memory only holds for one workspace or one agent, declare workspace_scope / agent_scope; otherwise leave both out. " +
    "An unscoped memory is visible everywhere; a scoped one is filtered or downranked outside its scope."
};

/**
 * #249 N3 的降级路径：宿主若不提供可挂钩的压缩前时机，双落点里的「注入」那一半就没
 * 有触发者。此时不把功能算作失败，而是把规则交给 agent 自判压力（§4.4 点名的降级
 * 形态）。落点是工具描述——常驻文本、不进每轮上下文，零注入成本。
 *
 * 英文单一正本，理由同 TOOL_GUIDE（见文件头）。字段名用存储与注入那一侧的口径
 * （`current_work` / `next_step` / open question，#249 §6.2）；规格 §4.4 里的
 * Current Work / Next Step / Critical Context 是**宿主压缩模板**的字段名，不是这里的。
 */
export const CONTINUITY_TOOL_RULE = {
  memory_save:
    " If this session's context is about to be compacted, first save a continuity note with this same tool " +
    "(type: project, title: one stable title for this line of work, e.g. \"continuity: <topic>\"): current_work (what you " +
    "are doing now), next_step, and any open question. Keep it to those fields, and reuse that same title for later " +
    "updates: the store merges rows of the same type + title (the merge appends to the note instead of replacing it), " +
    "so a fresh title each time just leaves a trail of near-duplicate project rows."
};
