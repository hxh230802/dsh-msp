/**
 * 信号绑定缓存：记住"哪个节点 + 哪个工具 → 哪条信号代表完成"。
 *
 * 绑定来自观测（后续事件的 payload 里出现了本次调用的句柄），不是配置。
 * 缓存是为了第二次省掉"广撒网"；清单变了自动失效（见 prune）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function bindingsPath(home = os.homedir()) {
  return path.join(home, ".dsh", "dsh-msp", "bindings.json");
}

/**
 * @param {string} file
 * @param {{validPaths?: Set<string>}} [opts] 传入则丢弃不在当前清单里的绑定（节点升级后信号改名）
 * @returns {Map<string, {donePath?: string, failPath?: string}>}
 */
export function loadBindings(file, opts = {}) {
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    for (const [key, value] of Object.entries(raw ?? {})) {
      if (!value || typeof value !== "object") continue;
      const entry = {};
      if (typeof value.donePath === "string") entry.donePath = value.donePath;
      if (typeof value.failPath === "string") entry.failPath = value.failPath;
      if (!entry.donePath && !entry.failPath) continue;
      if (opts.validPaths) {
        const ok = [entry.donePath, entry.failPath]
          .filter(Boolean)
          .every((p) => opts.validPaths.has(p));
        if (!ok) continue;
      }
      map.set(key, entry);
    }
  } catch {
    /* 缺失/损坏都当作没有绑定 */
  }
  return map;
}

/** 落盘（尽力而为，失败不影响功能）。 */
export function saveBindings(file, map) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const out = {};
    for (const [key, value] of map) out[key] = value;
    fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}
