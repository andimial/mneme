// #368 v1：记忆库落点检测（只检测不搬迁）。
// 启发式上限：只认显式的 "profiles" 路径段、且其下至少还有一段（作用域目录）；
// 不做「这个目录看起来像用户数据」之类的猜测——漏报可容忍（用户仍可自查文档
// 的落点建议），误报不可（每次启动都告警等于狼来了）。跨平台：分隔符统一成 /
// 后按段比较，大小写不敏感（Windows 与大小写不敏感文件系统）。库自身默认
// ~/.dsh/memory 不含该段，天然不触发。
// 返回命中的作用域目录名（如 "profiles/demo/memory" 里的 "demo"），未命中返回 null。
export function findProfileScopeSegment(dir) {
  if (typeof dir !== "string") return null;
  const parts = dir.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  const i = parts.indexOf("profiles");
  return i !== -1 && i < parts.length - 1 ? parts[i + 1] : null;
}
