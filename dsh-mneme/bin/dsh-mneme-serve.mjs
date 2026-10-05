#!/usr/bin/env node
// bin/dsh-mneme-serve.mjs —— mneme 独立服务(daemon)入口。
//
// 为什么独立成 bin 而不是 cli.mjs 的子命令:CONTRIBUTING「The CLI is dependency-free
// by contract」禁止给 bin/cli.mjs 加 import,而 serve 必须挂载 lib/serve.js;命名循
// dsh-mneme-mcp 先例。数据面 = src/api-standalone.js 同一工厂,路由与鉴权零新面。
//
// 生命周期:bind 失败(含 strictPort 下端口被占)→ stderr 清错 + exit 1;
// SIGINT/SIGTERM → dispose + exit 0。Windows 下 kill() 是硬终止、handler 不跑:
// 已提交事务由 WAL 回放兜底(node:sqlite 未 finalize 语句的 close 抛错同理),不丢数据。
//
// 日志纪律:进度/错误全走 stderr;stdout 只在就绪时打一行机器可读的 listening 行
// (脚本/测试从中解析实际端口),其余时刻保持干净——serve 是常驻进程,stdout 常被
// 重定向进监控管道。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createServeRuntime } from "../lib/serve.js";

const BIN_NAME = "dsh-mneme-serve";
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

const USAGE = `${BIN_NAME} — run the mneme data plane as a standalone service (no DSH required)

Usage: dsh-mneme-serve [--memory-dir <dir>] [--port <n>] [--host <addr>]

Options:
  --memory-dir <dir>  data directory (default: ~/.dsh/memory, same as the plugin)
  --port <n>          HTTP port (default: persisted external_api port, else 8790)
  --host <addr>       bind address (default: persisted external_api host, else 127.0.0.1)
  -h, --help          show this help
  -V, --version       print version

Auth: Bearer token is shared with the DSH panel / CLI (kv "external_api" in
memory.db); it is generated on first boot. A busy configured port is a hard
error — the DSH external API and this daemon must not share a port (pick one).`;

/** 极简 argv 解析(--k=v / --k v / 旗标);够用即可,完整 CLI 在 bin/cli.mjs。 */
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-V" || a === "--version") out.version = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const v = argv[i + 1];
        if (v !== undefined && !v.startsWith("--")) { out[a.slice(2)] = v; i++; }
        else out[a.slice(2)] = true;
      }
    } else {
      fail(`未知参数: ${a}\n运行 \`${BIN_NAME} --help\` 查看用法。`);
    }
  }
  return out;
}

function fail(msg) {
  console.error(`[${BIN_NAME}] ${msg}`);
  process.exit(1);
}

// api-standalone 的 logger 契约:info/warn/error 收单字符串。全走 stderr(见头部纪律)。
const logger = {
  info: (msg) => console.error(`[dsh-mneme] ${msg}`),
  warn: (msg) => console.error(`[dsh-mneme] warn: ${msg}`),
  error: (msg) => console.error(`[dsh-mneme] error: ${msg}`)
};

async function main(argv) {
  const args = parseArgv(argv);
  if (args.help) { process.stdout.write(USAGE + "\n"); return; }
  if (args.version) { console.log(PKG.version); return; }

  // memoryDir:CLI > env > serve.js 缺省(~/.dsh/memory)。相对路径按 CWD 解;
  // 前导 ~ 留给 serve.js 展开(与宿主 index.js:192-194 同一口径)。
  const rawDir = typeof args["memory-dir"] === "string" ? args["memory-dir"]
    : (typeof process.env.DSH_MNEME_MEMORY_DIR === "string" && process.env.DSH_MNEME_MEMORY_DIR ? process.env.DSH_MNEME_MEMORY_DIR : undefined);
  const memoryDir = rawDir && !rawDir.startsWith("~") ? resolve(rawDir) : rawDir;

  let port;
  if (args.port !== undefined) {
    port = Number(args.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      fail(`--port 需要合法端口(0-65535),收到: ${args.port}`);
    }
  }
  const host = typeof args.host === "string" && args.host ? args.host : undefined;

  const rt = createServeRuntime({ memoryDir, port, host, logger });
  try {
    await rt.api.ready;
  } catch (err) {
    fail(`数据面启动失败: ${err?.message ?? err}\n` +
      `  端口 ${rt.api.port} 被占通常意味着另一个 mneme 数据面正在运行` +
      `(DSH 的「外部访问」或另一份 ${BIN_NAME})——二选一,或用 --port 换端口。`);
  }
  const addr = rt.api.server.address();
  // stdout 唯一一行:机器可读就绪行(测试/脚本解析端口用)。
  console.log(`${BIN_NAME} listening on http://${addr?.address ?? rt.api.host}:${addr?.port ?? rt.api.port} (pid ${process.pid})`);
  if (!rt.tokenExisted) {
    console.error(`[dsh-mneme] 首次启动已生成 Bearer token(已持久化,与 DSH 面板/CLI 共用):\n` +
      `  ${rt.api.token}`);
  }

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.error(`[dsh-mneme] ${signal} received, closing...`);
    try { rt.dispose(); } catch { /* dispose 各步自吞 */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
