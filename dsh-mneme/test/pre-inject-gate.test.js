import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { createPreInjectGate } from "../src/pre-inject-gate.js";
import { applyLightModePreset } from "../src/config.js";

// Issue #380：注入前判定（preInjectGate）。两级语义复用 writeAdmission——
// enabled 跑判定（观察档，审计行看真实负载的意见分布）、enforce 缓存命中帧真滤除；
// 都默认关（默认路径逐字节一致，平价锁）。宿主 systemPrompt 渲染是同步回调：
// 判定走 async prefetch + cache 同步消费，冷缓存首帧降级为原样注入（防线故障
// 永不阻塞注入）；判定结果绝不进模型上下文（E2/E3：给模型看标记的线整条关闭；
// E12：过滤 D1 比标记 D2 好 +17.6pp）。pin 池（#249 逐字保真）与 graphHint 线索
// 行豁免——判定与过滤只作用于一般记忆槽（豁免规则在 inject.js 的 judgedPart）。

// ---- 测试基建 --------------------------------------------------------------

// 假 LLM：按脚本出牌（每 stream() 消费一个脚本项），记录调用入参。
// 脚本项：{ json }（成功回该 JSON）/ { error: true }（stream 抛错）/
// { garbage: true }（不可解析输出）/ { hang: true }（挂起但响应 signal——真宿主
// 的取消语义）/ { hangForever: true }（挂起且无视 signal——不守约的宿主）。
function fakeLlm(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async *stream(options) {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      calls.push({ options, messages: options.messages });
      if (step.error) throw new Error("boom: llm down");
      if (step.hang) {
        await new Promise((_, rej) => {
          if (options.signal?.aborted) { rej(new Error("aborted")); return; }
          options.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
        });
      }
      if (step.hangForever) await new Promise(() => { /* 挂起且无视 signal */ });
      const text = step.garbage ? "抱歉我不能输出 JSON" : JSON.stringify(step.json);
      yield { type: "text-delta", text };
      yield { type: "usage", usage: { input_tokens: 100, output_tokens: 20 } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  };
}

const agentDefaultModel = { currentSelection: () => ({ provider: "test", model: "judge-1" }) };

function setup(config = {}, llm = null, gateOpts = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const contexts = [];
  const ctx = {
    systemPrompt: {
      context(def) { contexts.push(def); return () => {}; }
    }
  };
  const settings = createSettings(store.db);
  const fullConfig = { maxInjectedItems: 5, importanceThreshold: 3, ...config };
  const gate = createPreInjectGate({ llm, agentDefaultModel, service, config: fullConfig, logger: null, ...gateOpts });
  createInjector(ctx, service, settings, fullConfig, gate);
  const memoryText = contexts.find((c) => c.name === "memory").text;
  return { store, service, gate, memoryText };
}

// 渲染一帧：ctx.agent.session 提供查询（lastUserQuery 走 snapshotEvents）。
const frame = (memoryText, query) => memoryText({
  agent: { session: { id: "s1", snapshotEvents: () => [
    { type: "user/message", data: { content: [{ type: "text", text: query }] } }
  ] } }
});

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

function seedPool(service) {
  // 三条 decision（非 pinned——pin 池豁免是单独的用例）。插入序 = 注入序的
  // 一般槽次序：m#0=预算决策 / m#1=立场决策 / m#2=事实决策。
  const a = service.saveWithDedupe({ type: "decision", title: "预算决策", content: "The user keeps the dinner budget under $340.", importance: 3 }).memory;
  const b = service.saveWithDedupe({ type: "decision", title: "立场决策", content: "The user believes stand-up meetings are an essential ritual and the right way to run a team.", importance: 3 }).memory;
  const c = service.saveWithDedupe({ type: "decision", title: "事实决策", content: "The user works from an office in Changsha.", importance: 3 }).memory;
  return [a, b, c];
}

const QUERY = "Help me plan the menu — what's my budget figure?";

const gateRows = (store) =>
  store.listLlmAudits({ limit: 20 }).filter((r) => r.trigger_source === "preInjectGate");

// ---- 用例 ------------------------------------------------------------------

test("两键默认关：闸门帧状态 off，渲染输出与无 gate 逐字节一致（平价锁）", () => {
  const bare = setup({});
  seedPool(bare.service);
  const without = frame(bare.memoryText, QUERY);

  const gated = setup({}, fakeLlm([{ json: { ids: ["m#0"], reason: "x" } }]));
  seedPool(gated.service);
  const withOff = frame(gated.memoryText, QUERY);

  assert.equal(withOff, without, "默认关 → 渲染逐字节一致");
  assert.equal(gated.gate.forFrame(QUERY, [], "s1").state, "off");
});

test("enabled 观察档：候选不动、审计行落分布（flagged ids / n_pool / n_flagged）", async () => {
  const llm = fakeLlm([{ json: { ids: ["m#1"], reason: "evaluative stance on meetings" } }]);
  const s = setup({ preInjectGate: { enabled: true } }, llm);
  seedPool(s.service);

  const t1 = frame(s.memoryText, QUERY);
  // 首帧冷缓存：原样注入（观察档不改候选集）
  for (const title of ["预算决策", "立场决策", "事实决策"]) assert.ok(t1.includes(title), `首帧降级原样注入：${title}`);

  await settle();
  const t2 = frame(s.memoryText, QUERY);
  for (const title of ["预算决策", "立场决策", "事实决策"]) assert.ok(t2.includes(title), "观察档不滤除");
  // 判定调用恰好一次（同 key 复用缓存），出参走 m#i 局部序号
  assert.equal(llm.calls.length, 1, "同 key 复用缓存，只判一次");
  const payload = JSON.parse(llm.calls[0].messages[1].content[0].text);
  assert.deepEqual(payload.memories.map((m) => m.id), ["m#0", "m#1", "m#2"], "判定池用 m#i 局部序号，不暴露 UUID");

  const rows = gateRows(s.store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model_id, "test:judge-1");
  assert.equal(rows[0].metadata.n_pool, 3);
  assert.equal(rows[0].metadata.n_flagged, 1);
  assert.equal(rows[0].metadata.degraded, false);
  assert.equal(rows[0].input_tokens, 100);
  assert.equal(rows[0].related_memory_ids.length, 1, "flagged id 映射回真实 UUID");
});

test("enforce：冷缓存首帧降级原样，缓存命中帧滤除被标记候选", async () => {
  const llm = fakeLlm([{ json: { ids: ["m#1"], reason: "stance" } }]);
  const { memoryText } = setup({ preInjectGate: { enabled: true, enforce: true } }, llm);
  const s = setup({ preInjectGate: { enabled: true, enforce: true } }, llm);
  seedPool(s.service);

  const t1 = frame(s.memoryText, QUERY);
  for (const title of ["预算决策", "立场决策", "事实决策"]) assert.ok(t1.includes(title), "首帧降级：原样注入");
  await settle();
  const t2 = frame(s.memoryText, QUERY);
  assert.ok(t2.includes("预算决策") && t2.includes("事实决策"), "未标记条目保留");
  assert.ok(!t2.includes("立场决策"), "被标记候选真的被滤除");
});

test("降级：LLM 抛错 → 原样渲染 + degraded 审计行 + 不缓存（下一帧重试）", async () => {
  const llm = fakeLlm([{ error: true }, { error: true }]);
  const { memoryText } = setup({ preInjectGate: { enabled: true } }, llm);
  const s = setup({ preInjectGate: { enabled: true } }, llm);
  seedPool(s.service);
  frame(s.memoryText, QUERY);
  await settle();
  frame(s.memoryText, QUERY); // 失败不缓存 → 第二帧重新判定
  await settle();
  assert.equal(llm.calls.length, 2, "失败不缓存，下一帧重试");
  const rows = gateRows(s.store);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].status, "error");
  assert.equal(rows[0].metadata.degraded, true);
});

test("降级：不可解析输出同样 degraded 且不缓存", async () => {
  const llm = fakeLlm([{ garbage: true }, { garbage: true }]);
  const { memoryText } = setup({ preInjectGate: { enabled: true } }, llm);
  const s = setup({ preInjectGate: { enabled: true } }, llm);
  seedPool(s.service);
  frame(s.memoryText, QUERY);
  await settle();
  frame(s.memoryText, QUERY);
  await settle();
  const rows = gateRows(s.store);
  assert.equal(rows[0].status, "error");
  assert.equal(rows[0].metadata.degraded, true);
  assert.equal(llm.calls.length, 2, "不可解析不缓存，下一帧重试");
});

test("出参映射：越界 m#i 忽略，绝不误滤真实条目", async () => {
  const llm = fakeLlm([{ json: { ids: ["m#0", "m#99"], reason: "r" } }]);
  const { service, gate, memoryText } = setup({ preInjectGate: { enabled: true, enforce: true } }, llm);
  seedPool(service);
  frame(memoryText, QUERY);
  await settle();
  const result = gate.forFrame(QUERY, service.injectCandidates({ maxItems: 5, threshold: 3 }), "s1");
  assert.equal(result.state, "filtered");
  assert.equal(result.flaggedIds.size, 1, "m#99 越界忽略，只滤真实命中的 1 条");
});

test("缓存键：查询或候选集变化 → 不吃旧判定（防陈旧过滤）", async () => {
  const llm = fakeLlm([
    { json: { ids: ["m#1"], reason: "r" } },
    { json: { ids: [], reason: "r" } }
  ]);
  const { service, gate, memoryText } = setup({ preInjectGate: { enabled: true } }, llm);
  seedPool(service);
  frame(memoryText, QUERY);
  await settle();
  assert.equal(gate.forFrame(QUERY, service.injectCandidates({ maxItems: 5, threshold: 3 }), "s1").state, "observed");
  frame(memoryText, "Another question entirely?");
  await settle();
  assert.equal(llm.calls.length, 2, "新查询触发新的池级判定");
});

test("in-flight 去重：同 key 并行帧只发一次判定调用", () => {
  const llm = fakeLlm([{ json: { ids: [], reason: "r" } }]);
  const { memoryText } = setup({ preInjectGate: { enabled: true } }, llm);
  const s = setup({ preInjectGate: { enabled: true } }, llm);
  seedPool(s.service);
  frame(s.memoryText, QUERY);
  frame(s.memoryText, QUERY); // 未 settle 的第二帧
  assert.equal(llm.calls.length, 1, "去重后只有一次调用");
});

test("pin 池豁免（inject.js judgedPart）：enforce 滤一般槽，preference 前缀原样", async () => {
  const llm = fakeLlm([{ json: { ids: ["m#0"], reason: "r" } }]);
  // pinnedInjectBudget 开 pin 前缀（默认 0 = pin 池关闭）；constraint 属编码类
  // 会被 codingGate 滤掉，pin 前缀用 preference。
  const { service, memoryText } = setup({ preInjectGate: { enabled: true, enforce: true }, pinnedInjectBudget: 3 }, llm);
  service.saveWithDedupe({ type: "preference", title: "硬偏好", content: "The user never deploys on Fridays.", importance: 4 });
  seedPool(service);
  frame(memoryText, QUERY);
  await settle();
  const t2 = frame(memoryText, QUERY);
  assert.ok(t2.includes("硬偏好"), "pin 池豁免：preference 前缀不被滤除");
  assert.ok(!t2.includes("预算决策"), "判定池（一般槽）第一条被滤除");
  assert.ok(t2.includes("立场决策") && t2.includes("事实决策"), "其余一般槽保留");
});

test("lightMode：预设翻转 preInjectGate.enabled 且不污染用户配置对象", () => {
  const user = { lightMode: true, preInjectGate: { enabled: true, enforce: true } };
  const preset = applyLightModePreset(user);
  assert.equal(preset.preInjectGate.enabled, false, "预设压回 false");
  assert.equal(preset.preInjectGate.enforce, true, "只翻列表里的点分键");
  assert.equal(user.preInjectGate.enabled, true, "不改到用户原对象（浅拷贝父对象）");
  const flat = applyLightModePreset({ lightMode: true, heatEnabled: true });
  assert.equal(flat.heatEnabled, false, "平铺键照旧直赋（既有行为回归）");
});

test("判定超时：abort 底层流（真宿主守约）→ degraded 审计 + 不缓存 + 下一帧重试（CodeRabbit on #382）", async () => {
  const llm = fakeLlm([{ hang: true }, { json: { ids: [], reason: "recovered" } }]);
  const s = setup({ preInjectGate: { enabled: true } }, llm, { judgeTimeoutMs: 50 });
  seedPool(s.service);
  frame(s.memoryText, QUERY);
  // 真实等待：50ms 超时定时器要真烧完（settle 的微任务不够）
  await new Promise((r) => setTimeout(r, 150));
  const rows = gateRows(s.store);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].status, "error", "超时按降级落账");
  assert.match(rows[0].error_message, /timeout/);
  frame(s.memoryText, QUERY); // abort 已让流停止（settled）→ 同 key 可重试
  await settle();
  assert.equal(llm.calls.length, 2, "流停止后同 key 可重试");
});

test("判定超时且宿主无视 signal：该 key 进冷却，不叠新流（CodeRabbit on #382）", async () => {
  const llm = fakeLlm([{ hangForever: true }]);
  const s = setup({ preInjectGate: { enabled: true } }, llm, { judgeTimeoutMs: 50 });
  seedPool(s.service);
  frame(s.memoryText, QUERY);
  // 超时 50ms + abort 宽限 2s（等流停止的判定）之后才写审计
  await new Promise((r) => setTimeout(r, 2300));
  const rows = gateRows(s.store);
  assert.ok(rows.length >= 1);
  assert.match(rows[0].error_message, /timeout/);
  frame(s.memoryText, QUERY); // 冷却中：不再发新流
  assert.equal(llm.calls.length, 1, "流未停止的 key 冷却内不叠新流");
  const again = s.gate.forFrame(QUERY, s.service.injectCandidates({ maxItems: 5, threshold: 3 }), "s1");
  assert.equal(again.state, "pending", "冷却内本帧原样注入（防线故障不阻塞）");
});

test("缓存键含候选内容：updateMemory 就地修正后不吃旧判定（CodeRabbit on #382）", async () => {
  const llm = fakeLlm([
    { json: { ids: ["m#1"], reason: "r" } },
    { json: { ids: [], reason: "r" } }
  ]);
  const { service, gate, memoryText } = setup({ preInjectGate: { enabled: true } }, llm);
  const [a, b] = seedPool(service);
  frame(memoryText, QUERY);
  await settle();
  assert.equal(gate.forFrame(QUERY, service.injectCandidates({ maxItems: 5, threshold: 3 }), "s1").state, "observed");
  // 同 id 内容被就地修正 → 旧判定不得沾新内容
  service.update(b.id, { content: "The user now believes stand-ups are useless." });
  frame(memoryText, QUERY);
  await settle();
  assert.equal(llm.calls.length, 2, "内容变化触发重新判定");
  void a;
});
