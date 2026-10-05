import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServeRuntime } from "../src/serve.js";

// daemon 装配面锁(test/serve-bin.test.js 另有真子进程 + 多进程共存):
// in-process 起真 HTTP(port 0,OS 分配),fetch 走 health / 401 / save / search /
// token 持久化复用全链路。锁的是「daemon 数据面 = api-standalone 同一工厂」这一契约。
// 基础用例一律 embed:"off"——不碰取件与模型 init,CI 确定性;向量走注入假 embedder。

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "mneme-serve-"));
}

/** 确定性 4 维伪嵌入:同词相关、异词近正交,足以让向量路径产生非零命中。 */
function fakeEmbedder() {
  return {
    ready: true,
    modelHash: "fake-hash-1",
    dimension: 4,
    embedSingle: async (text) => {
      const v = [0, 0, 0, 0];
      for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i) % 7;
      const n = Math.hypot(v[0], v[1], v[2], v[3]) || 1;
      return v.map((x) => x / n);
    }
  };
}

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try { return await fn(); } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}: ${lastErr?.message ?? lastErr}`);
}

test("serve: /health 免鉴权,业务路由无 token 401", async () => {
  const dir = tmpDir();
  const rt = await createServeRuntime({ memoryDir: dir, port: 0, embed: "off" });
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
  const rt = await createServeRuntime({ memoryDir: dir, port: 0, embed: "off" });
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
  const rt2 = await createServeRuntime({ memoryDir: dir, port: 0, embed: "off" });
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
  const rt = await createServeRuntime({ memoryDir: dir, port: 0, embed: "off" });
  await rt.api.ready;
  const port = rt.api.port;
  // dispose 现为 async:等 server.close 回调(在途请求排干)后再重绑
  await rt.dispose();
  // 端口释放可能有内核级迟滞,重试绑定而不是假设立即可用
  let rebound = null;
  for (let i = 0; i < 10 && !rebound; i++) {
    try {
      const rt2 = await createServeRuntime({ memoryDir: dir, port, embed: "off" });
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
    await rebound?.dispose();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});

test("serve: 注入假 embedder → 写入即嵌入,vector 轴接管检索;auto 检索可用", async () => {
  const dir = tmpDir();
  const fake = fakeEmbedder();
  const rt = await createServeRuntime({ memoryDir: dir, port: 0, embed: "off", embedder: fake });
  await rt.api.ready;
  try {
    // 覆盖注入生效:semantic 被绕过,embedder 直接挂 service
    assert.equal(rt.semantic, null);

    const base = `http://127.0.0.1:${rt.api.port}`;
    const auth = { authorization: `Bearer ${rt.api.token}` };
    const save = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", title: "向量注入冒烟", content: "daemon 侧写入即嵌入", importance: 3 })
    });
    assert.equal(save.status, 201);

    // 写入侧嵌入是异步排队的:轮询到 vector 轴命中为止。auto 模式不断言 mode 字段 ——
    // 标题同词命中时融合合并对象是 keyword 行,上游 mneme 的 auto 报告语义如此
    // (vector:true 标记只在纯向量来源上保留),那是上游行为,不是 daemon 契约。
    await waitFor(async () => {
      const res = await fetch(`${base}/search?q=${encodeURIComponent("向量注入冒烟")}&mode=vector`, { headers: auth });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.mode, "vector", "mode=vector must report the vector axis");
      assert.ok((body.items ?? []).some((m) => m.title === "向量注入冒烟"));
      return true;
    }, 8000, "vector-axis search");

    const autoRes = await fetch(`${base}/search?q=${encodeURIComponent("向量注入冒烟")}&mode=auto`, { headers: auth });
    assert.equal(autoRes.status, 200);
    assert.ok(((await autoRes.json()).items ?? []).some((m) => m.title === "向量注入冒烟"));

    // /context 全链路（issue #370）：daemon 与宿主外部访问共用同一工厂，注入
    // 候选端点一并带出——同一 embedder 句柄喂查询向量，injectCandidates 走通。
    const ctxRes = await fetch(`${base}/context?q=${encodeURIComponent("向量注入冒烟")}`, { headers: auth });
    assert.equal(ctxRes.status, 200);
    const ctxBody = await ctxRes.json();
    assert.ok((ctxBody.items ?? []).some((m) => m.title === "向量注入冒烟"));
    // #217 注入分账：injectCandidates 的曝光型访问事件落 recall_runs
    // （mode='inject'），第三方的注入统计与宿主注入同表同口径。
    const injectRuns = rt.store.db.prepare("SELECT count(*) AS c FROM recall_runs WHERE mode = 'inject'").get().c;
    assert.ok(injectRuns >= 1, "injection access must be receipted in recall_runs (#217)");
  } finally {
    rt.dispose();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});

test("serve: 非法 embed provider 拒装配;embed=off 时 semantic 为 null", async () => {
  const dir = tmpDir();
  await assert.rejects(
    createServeRuntime({ memoryDir: dir, port: 0, embed: "bogus" }),
    /invalid embed provider/
  );
  const rt = await createServeRuntime({ memoryDir: dir, port: 0, embed: "off" });
  try {
    assert.equal(rt.semantic, null, "off path must not assemble a semantic pipeline");
  } finally {
    rt.dispose();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});
