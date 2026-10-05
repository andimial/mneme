import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServeRuntime } from "../src/serve.js";

// daemon 装配面锁(test/serve-bin.test.js 另有真子进程 + 多进程共存):
// in-process 起真 HTTP(port 0,OS 分配),fetch 走 health / 401 / save / search /
// token 持久化复用全链路。锁的是「daemon 数据面 = api-standalone 同一工厂」这一契约。

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "mneme-serve-"));
}

test("serve: /health 免鉴权,业务路由无 token 401", async () => {
  const dir = tmpDir();
  const rt = createServeRuntime({ memoryDir: dir, port: 0 });
  await rt.api.ready;
  try {
    const base = `http://127.0.0.1:${rt.api.port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const noAuth = await fetch(`${base}/search?q=x`);
    assert.equal(noAuth.status, 401);
    assert.deepEqual(await noAuth.json(), { error: "unauthorized" });
  } finally {
    rt.dispose();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* win 文件锁偶发 */ }
  }
});

test("serve: save → search 走通;token 持久化 kv;二次启动复用同一 token;检索回执落 recall_runs", async () => {
  const dir = tmpDir();
  const rt = createServeRuntime({ memoryDir: dir, port: 0 });
  await rt.api.ready;
  const base = `http://127.0.0.1:${rt.api.port}`;
  const auth = { authorization: `Bearer ${rt.api.token}` };

  // 全新目录:首次启动生成 token
  assert.equal(rt.tokenExisted, false);

  const save = await fetch(`${base}/memories`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ type: "preference", title: "serve 冒烟偏好", content: "回复保持简短", importance: 4 })
  });
  assert.equal(save.status, 201);

  const search = await fetch(`${base}/search?q=${encodeURIComponent("简短")}`, { headers: auth });
  assert.equal(search.status, 200);
  const searchBody = await search.json();
  assert.ok((searchBody.items ?? []).some((m) => m.title === "serve 冒烟偏好"));

  // token 持久化在 kv external_api(与 DSH 面板/CLI 共用同一凭证通道)
  assert.equal(rt.settings.getExternalApi().token, rt.api.token);

  // 检索回执:recorder 已接(index.js:294-309 同款),recall_runs 不缺数 —— #363 回帖
  // 向 bridge 承诺过「第三方检索的复用统计不受影响」,这条就是该承诺的回归锁。
  const recallRows = rt.store.db.prepare("SELECT COUNT(*) AS n FROM recall_runs").get();
  assert.ok(recallRows.n >= 1, "recall_runs should record the search above");

  rt.dispose();

  // 二次启动同目录:token 复用不重新生成(firstBoot 提示只在真正首次出现)
  const rt2 = createServeRuntime({ memoryDir: dir, port: 0 });
  await rt2.api.ready;
  try {
    assert.equal(rt2.tokenExisted, true);
    assert.equal(rt2.api.token, rt.api.token);
  } finally {
    rt2.dispose();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});

test("serve: dispose 后端口可复用(同端口连起两轮不踩 strictPort)", async () => {
  const dir = tmpDir();
  const rt = createServeRuntime({ memoryDir: dir, port: 0 });
  await rt.api.ready;
  const port = rt.api.port;
  rt.dispose();
  // dispose 同步关库;端口释放可能有内核级迟滞,重试绑定而不是假设立即可用
  let rebound = null;
  for (let i = 0; i < 10 && !rebound; i++) {
    try {
      const rt2 = createServeRuntime({ memoryDir: dir, port });
      await rt2.api.ready;
      rebound = rt2;
    } catch (err) {
      if (err?.code !== "EADDRINUSE") throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    assert.ok(rebound, "port should be rebindable after dispose");
    assert.equal(rebound.api.port, port);
  } finally {
    rebound?.dispose();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});
