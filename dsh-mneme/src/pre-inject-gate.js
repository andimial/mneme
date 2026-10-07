// Issue #380 注入前判定（preInjectGate）：每帧注入候选出池后、进入 system prompt
// 前，由一次池级 LLM 调用判出「会向本次请求注入意见/立场」的记忆（E12 D1 口径：
// 判定协议与实验 protocol-preinject.txt 同源；「意见/立场」框架依据 E3 读数 2
// 「FR 跟随意见内容」，且已被用户采纳为执行期决策）。
//
// 两条硬约束决定了本模块的形状：
// 1. 宿主 systemPrompt 渲染是同步回调（inject.js 的 text callback 不支持 await，
//    service.js Bug4 注释同源）——判定只能 async prefetch + cache、同步消费，与
//    inject.js 的 queryVectorCache 同款。冷缓存首帧降级为不判定原样注入，下一轮
//    同 key 渲染生效；防线故障永不阻塞注入。
// 2. 判定只给闸门用，绝不进模型上下文——给模型看任何标记的整条线已被 E2/E3
//    关闭（E12：判定+标记 D2 比判定+过滤 D1 差 +17.6pp）。
//
// 两级语义复用 #254 writeAdmission（enabled 观察档 / enforce 真拦截）：
//   enabled=true 才跑判定；enforce=true 且缓存命中时同步滤除被标记候选；
//   observe 档（enforce=false）候选集不动，判定完成时落审计行看真实负载的意见
//   占比分布（issue：先测分布再决定 enforce）。
//
// 审计走 llm_audit_logs：trigger_source="preInjectGate"，真实 model_id 与 token
// 用量（区别于 writeAdmission 的 "skipped"/"-" 占位——本闸有真实 LLM 花费，面板
// 消费视图自动生效），related_memory_ids=被标记记忆的真实 UUID，metadata 带分布
// 与降级标记。llmAudit 关闭时本闸不运行（与 write-admission 的 evaluate 早退同
// 口径：无保留期的表不记账，无账目的判定不可见也不该花钱）。
//
// 候选映射为 m#<i> 局部序号参与判定、出参映射回真实 UUID——E13b 实测模型抄 36
// 位 UUID 的错误率足以让整单决策作废，局部短 id 是同源解法。
import { STR, langOf } from "./lang.js";

export const GATE_TRIGGER_SOURCE = "preInjectGate";
export const GATE_OPERATION_TYPE = "pre_inject_gate";
// 判定输出上限：E12 实验同款硬编码（700），池级单次判定足够。
const JUDGE_MAX_TOKENS = 700;
// 缓存容量与 inject.js 的 queryVectorCache 同口径（cap 8，丢最旧）。
const VERDICT_CACHE_MAX = 8;

function extractJson(content) {
  const s = String(content ?? "").trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

export function createPreInjectGate({ llm, agentDefaultModel, service, config, logger, judgeTimeoutMs } = {}) {
  const language = langOf(config);
  const enabled = config?.preInjectGate?.enabled === true;
  const enforce = config?.preInjectGate?.enforce === true;
  // llmAudit 关闭 → 本闸不运行（见文件头：无账目的判定不可见也不该花钱）。
  const auditDisabled = config?.llmAudit?.enabled === false;
  const usable = enabled && !auditDisabled && typeof llm?.stream === "function";
  if (enabled && !usable) {
    logger?.warn?.("[dsh-mneme] preInjectGate enabled but unusable (llm missing or llmAudit disabled) — running as off");
  }

  const verdictCache = new Map(); // cacheKey -> { flaggedIds: Set<uuid>, nPool, reason }
  const inFlight = new Map();     // cacheKey -> Promise（并行渲染去重，防调用风暴）

  // cacheKey = 查询 + 排序后的「id:content」：查询变、候选集变、**候选内容变**
  // （updateMemory 就地修正）都换 key——旧判定不沾新内容（CodeRabbit on #382）。
  // 排序保证同池同 key（等价池确定性）；内容进 key 换来的是 map 占用略涨，
  // 缓存 cap 8 有界。
  function cacheKey(query, candidates) {
    return `${query}\u0000${candidates.map((c) => `${c.id}:${c.content}`).sort().join("\u0001")}`;
  }

  function getCached(key) {
    return verdictCache.get(key) ?? null;
  }

  // 渲染帧的唯一同步入口（text callback 内调用，绝不 await）。返回
  //   state: "off"      闸门未启用/不可用/空池，调用方原样
  //          "filtered"  缓存命中 + enforce：调用方按 flaggedIds 滤除
  //          "observed"  缓存命中 + observe：候选未动，分布已知（flaggedIds 带回）
  //          "pending"   冷缓存：本帧原样渲染，判定已在后台发起
  // flaggedIds 只在缓存命中时非空。豁免（pin 池/graphHint 线索行不进判定集）由
  // 调用方在传入 judgedPart 时完成——本模块只认传入的池。
  function forFrame(query, candidates, sessionId) {
    if (!usable || !Array.isArray(candidates) || candidates.length === 0) {
      return { state: "off", flaggedIds: null, nPool: 0 };
    }
    const key = cacheKey(query, candidates);
    const cached = verdictCache.get(key);
    if (cached) {
      return {
        state: enforce ? "filtered" : "observed",
        flaggedIds: cached.flaggedIds,
        nPool: cached.nPool
      };
    }
    prefetch(key, query, candidates, sessionId);
    return { state: "pending", flaggedIds: null, nPool: candidates.length };
  }

  function prefetch(key, query, candidates, sessionId) {
    if (verdictCache.has(key) || inFlight.has(key)) return;
    const promise = judgePool(query, candidates, sessionId)
      .then((verdict) => {
        inFlight.delete(key);
        // 判定失败（null）不缓存：下一帧重试；成功才进缓存。
        if (verdict) {
          verdictCache.set(key, verdict);
          if (verdictCache.size > VERDICT_CACHE_MAX) {
            verdictCache.delete(verdictCache.keys().next().value);
          }
        }
      })
      .catch(() => { inFlight.delete(key); });
    inFlight.set(key, promise);
  }

  // 单次池级判定（E12 口径：1 次调用判整池，不逐条）。返回
  // { flaggedIds, nPool, reason } 或 null（失败/不可解析——审计行记 degraded）。
  async function judgePool(query, candidates, sessionId) {
    let route = {};
    try {
      const sel = agentDefaultModel?.currentSelection?.();
      if (sel?.provider && sel?.model) { route.provider = sel.provider; route.model = sel.model; }
    } catch { /* fall through：无路由则审计行留空模型——entity adapter 的 #372 同款 */ }
    const modelId = route.provider && route.model ? `${route.provider}:${route.model}` : "";
    const startedAt = Date.now();
    const timestamp = new Date(startedAt).toISOString();
    const source = { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" };
    const messages = [
      { role: "system", content: [{ type: "text", text: STR.prompts.preInjectGate[language] }], source },
      { role: "user", content: [{ type: "text", text: JSON.stringify({ query, memories: candidates.map((c, i) => ({ id: `m#${i}`, content: c.content })) }) }], source },
    ];

    let text = null;
    let errorMessage = null;
    let inputTokens = 0;
    let outputTokens = 0;
    // 判定超时（CodeRabbit on #382）：stream 挂起会让 inFlight 永久占住 key、
    // 同 key 不再重试、连 degraded 审计行都没有——与本模块「超时 → degraded、
    // 不缓存」的文档口径必须一致。消费循环用 Promise.race 兜底（宿主 llm.stream
    // 的 signal 支持未约定，不依赖）；超时后放弃消费、按降级落账，inFlight 由
    // prefetch 的 finally 清理，下一帧可重试。
    const JUDGE_TIMEOUT_MS = judgeTimeoutMs ?? 60000;
    let timeoutTimer;
    try {
      const consume = (async () => {
        for await (const chunk of llm.stream({ ...route, maxTokens: JUDGE_MAX_TOKENS, messages })) {
          if (chunk.type === "text-delta" && typeof chunk.text === "string") text = (text ?? "") + chunk.text;
          if (chunk.type === "usage") {
            const u = chunk.usage ?? chunk;
            const i = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? u.promptTokens;
            const o = u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.completionTokens;
            if (Number.isFinite(i)) inputTokens = i;
            if (Number.isFinite(o)) outputTokens = o;
          }
          if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
            errorMessage = "llm stream aborted or errored";
            return;
          }
        }
      })();
      consume.catch(() => { /* 超时后 consume 仍在跑：其拒绝已由 race 接过一次，这里防未处理拒绝 */ });
      await Promise.race([
        consume,
        new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error(`judgment timeout (${JUDGE_TIMEOUT_MS}ms)`)), JUDGE_TIMEOUT_MS);
        })
      ]);
      clearTimeout(timeoutTimer);
    } catch (err) {
      clearTimeout(timeoutTimer);
      errorMessage = String(err?.message ?? err);
      logger?.warn?.(`[dsh-mneme] preInjectGate judgment failed: ${errorMessage}`);
    }

    // 出参解析：m#<i> → 数组索引 → 真实 UUID。越界/重复/非本池 id 一律忽略
    // （解析宽松、应用严格：模型幻觉出的 id 不能滤掉任何真实条目）。
    const parsed = errorMessage ? null : extractJson(text);
    const flaggedIds = new Set();
    let reason = null;
    if (parsed && Array.isArray(parsed.ids)) {
      for (const raw of parsed.ids) {
        const m = /^m#(\d+)$/.exec(String(raw));
        const idx = m ? Number(m[1]) : -1;
        if (idx >= 0 && idx < candidates.length) flaggedIds.add(candidates[idx].id);
      }
      if (typeof parsed.reason === "string" && parsed.reason.trim()) reason = parsed.reason.trim().slice(0, 300);
    } else if (!errorMessage) {
      errorMessage = "unparseable judgment output";
    }
    const degraded = flaggedIds.size === 0 && (errorMessage !== null || !parsed);

    // 审计 best-effort（CONTRIBUTING fail-safe 硬约定）：写行失败只 warn。
    // llmAudit 关闭时 usable 已为 false，这里理论不可达；防御性再判一次。
    if (config?.llmAudit?.enabled !== false && typeof service?.saveLlmAudit === "function" && modelId) {
      try {
        service.saveLlmAudit({
          timestamp,
          trigger_source: GATE_TRIGGER_SOURCE,
          operation_type: GATE_OPERATION_TYPE,
          model_id: modelId,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cost_usd: 0,
          duration_ms: Date.now() - startedAt,
          status: degraded ? "error" : "success",
          error_message: errorMessage,
          related_memory_ids: [...flaggedIds],
          session_key: sessionId ?? null,
          metadata: {
            n_pool: candidates.length,
            n_flagged: flaggedIds.size,
            ...(reason ? { reason } : {}),
            degraded
          }
        });
      } catch (auditError) {
        logger?.warn?.(`[dsh-mneme] preInjectGate audit write failed: ${String(auditError)}`);
      }
    }

    if (degraded) return null;
    return { flaggedIds, nPool: candidates.length, reason };
  }

  function clear() {
    verdictCache.clear();
    inFlight.clear();
  }

  return { enabled: usable, enforce, cacheKey, getCached, forFrame, clear };
}
