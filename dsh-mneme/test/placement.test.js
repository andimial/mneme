import test from "node:test";
import assert from "node:assert/strict";
import { findProfileScopeSegment } from "../src/placement.js";

// issue #368 验收 1：判定带阴性对照。下面的正反用例成对出现——判定改成恒真
// 时负例必红、恒假时正例必红，锁有牙齿。

// 正例：profiles/<作用域>/…（含 issue 原文的形状）
for (const dir of [
  "/home/user/.dsh/profiles/demo/memory/", // issue 验收用例：…/profiles/demo/memory/
  "C:\\Users\\u\\profiles\\demo\\memory", // Windows 分隔符
  "/srv/dsh/PROFILES/demo/memory", // 大小写不敏感
  "profiles/x/memory.db", // profiles 在根
  "/a/b/profiles/x", // 作用域是最后一段（仍是命中）
]) {
  test(`placement: profile-scoped path warns — ${dir}`, () => {
    assert.ok(findProfileScopeSegment(dir) !== null, `expected a hit for ${dir}`);
  });
}
assert.equal(findProfileScopeSegment("/a/b/profiles/x"), "x", "returns the scope dir name");

// 负例：默认落点与普通数据目录
for (const dir of [
  "/home/user/.dsh/memory", // 默认值（issue：默认本身在 profiles 之外）
  "C:\\Users\\石晴\\AppData\\Local\\memory", // Windows 普通目录
  "/srv/data/memory", // issue 验收用例：…/data/memory/
  "/srv/data/profiles", // profiles 是最后一段 = 没有作用域目录，不算命中
  "/srv/data/myprofiles/demo", // 子串不算：段必须整段等于 profiles
  "", // 空串
  null, // 非字符串（防御）
  undefined,
]) {
  test(`placement: non-profile path stays silent — ${String(dir)}`, () => {
    assert.equal(findProfileScopeSegment(dir), null, `expected no hit for ${String(dir)}`);
  });
}
