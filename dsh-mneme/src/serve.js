// src/serve.js —— 独立服务(daemon)运行时:mneme 在 DSH 宿主之外常驻的最小装配面
// (#363 承诺的「官方推荐第三方挂载姿势」)。bin/dsh-mneme-serve.mjs 是它的 CLI 壳,
// Mneme Bridge 这类第三方也可直接 import 本模块自行托管生命周期。
//
// 与宿主装配(src/index.js apply)的关系:只搬数据面那一半,每步注释锚定 index.js
// 来源行号。刻意不抽公共装配函数——apply 的其余环节(注入/工具/dream)与宿主 ctx
// 纠缠,防御段纪律是「最后动或不动」;这 60 行的漂移风险由 serve-bin 测试的多进程
// 共存用例兜底(两侧真开同一个库互写互读)。
//
// 第一期无 LLM:巩固(autoDream)与蒸馏(autoSummarize)结构上不在这里——巩固只
// 属于 DSH 宿主进程,这就是 daemon 与宿主「单写者」的机械保证(AGENTS.md 的
// externalApi/autoDream 单侧纪律),不依赖用户自觉。检索是关键词 + BM25(service
// 内建);向量管线由 PR2 的 semantic 抽取接入。
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { createSettings } from "./settings.js";
import { createMirror, TYPE_FILE } from "./mirror.js";
import { langOf } from "./lang.js";
import { createService } from "./service.js";
import { createMaintenance } from "./maintenance.js";
import { createStandaloneApi } from "./api-standalone.js";

/**
 * 组装并启动一个独立数据面。
 * @param {object} opts
 *   memoryDir  — 数据目录;缺省与宿主同默认 ~/.dsh/memory(config.js:9),支持前导 ~。
 *   port/host  — 透传 createStandaloneApi;缺省走 kv external_api 持久值 > 8790/127.0.0.1。
 *   logger     — console 形状(info/warn/error,收单字符串);缺省 null(全链路容缺)。
 *   strictPort — 默认 true:配置端口被占即失败(第三方把 URL 写死,顺延=静默打到
 *                错误端口)。显式 port=0(测试/OS 分配)不受影响。
 * @returns {api, store, service, settings, maintenance, tokenExisted, dispose}
 *   tokenExisted — 启动前 kv 里是否已有 token;false 时本次为首次生成,入口层可提示。
 */
export function createServeRuntime({ memoryDir, port, host, logger = null, strictPort = true } = {}) {
  // index.js:192-195:~ 展开只认前导;目录不存在时 node:sqlite 直接抛,先 mkdir。
  const dir = String(memoryDir || join(homedir(), ".dsh", "memory")).replace(/^~(?=$|[\\/])/, homedir());
  mkdirSync(dir, { recursive: true });

  // 装配顺序照 index.js:197-292:store → settings → mirror → service → recoverMirror。
  const store = createStore(join(dir, "memory.db"));
  const settings = createSettings(store.db);
  // 第一期不吃宿主 config schema(schemastery 是宿主 peer 依赖,独立进程装不装随缘),
  // 配最小集,与第三方 embedded 挂载实测同形:language 参与镜像渲染与去重标题;
  // documentMemoryEnabled 关掉 document 子系统(daemon 不建 documentIndex,service
  // 内部 if-guard 安全,index.js:261 的 documentIndex 仅宿主装配)。
  const cfg = { language: "zh", documentMemoryEnabled: false };
  const mirror = createMirror(dir, langOf(cfg));
  const service = createService({ store, mirror, config: cfg, logger });

  // index.js:292:上次镜像同步失败留下的 dirty 状态,启动时安全重渲一次(内部自吞)。
  service.recoverMirror();

  // index.js:319-332:人改镜像先合并——镜像文件里的手工编辑每次启动都赢。
  // readHumanEdits 全类型一次读齐:mergeHumanEdits 成功会重渲全部镜像,逐类型读改
  // 循环会拿没读到的类型覆盖掉未合并的编辑(index.js:324-327 注释同款坑)。
  const humanEdits = new Map();
  for (const type of Object.keys(TYPE_FILE)) humanEdits.set(type, mirror.readHumanEdits(type));
  for (const [type, edits] of humanEdits) {
    if (edits.length) service.mergeHumanEdits(type, edits);
  }

  // index.js:294-309:检索回执落 recall_runs(searchMemories 的 recordRecall 默认开,
  // 第三方检索统计因此不缺数)。best-effort:回执写失败绝不影响检索本身。
  service.setRecallRecorder((recall) => {
    try {
      store.saveRecallRun({
        query: recall.query,
        mode: recall.mode,
        topK: recall.topK,
        threshold: recall.threshold ?? null,
        candidates: recall.candidates ?? [],
        created_at: recall.createdAt
      });
    } catch { /* non-fatal: recall recording is bookkeeping */ }
  });

  // index.js:636:#275 无损回收。daemon 带上它,POST /maintenance/reclaim 才有后端
  // (api-standalone 缺 maintenance 时该路由 503);同样不挂启动路径、不接定时器。
  const maintenance = createMaintenance({ store, config: cfg, logger });

  // index.js:643-649 同一工厂;差别只有 strictPort 默认开(daemon 语义,见上)。
  // token 与宿主共用同一 kv 键 external_api:首次启动自动生成并持久化
  // (api-standalone.js:203-212),DSH 面板 / CLI / daemon 三方零配置共享凭证。
  const tokenExisted = Boolean(settings.getExternalApi?.()?.token);
  const api = createStandaloneApi({ service, store, config: cfg, logger, settings, port, host, maintenance, strictPort });

  return {
    api,
    store,
    service,
    settings,
    maintenance,
    tokenExisted,
    /**
     * 收尾：先停收新请求、等在途请求跑完，再关库——直接同步关库会让在途的
     * PUT/POST 撞上已关的 store（500 或丢写）。closeIdleConnections 排干
     * keep-alive 空闲连接（node ≥18.2，旧版无此 API 则跳过），否则 server.close
     * 的回调要等 keep-alive 超时才触发。node:sqlite 对未 finalize 语句可能抛，
     * 吞掉——WAL 会在下次打开时回放，已提交事务不丢。
     */
    async dispose() {
      await new Promise((resolve) => {
        try {
          api.server.close(() => resolve());
          api.server.closeIdleConnections?.();
        } catch { resolve(); }
      });
      try { store.close(); } catch { /* 同上 */ }
    }
  };
}
