/**
 * 本进程在 MSP 网络里的 node_id。
 *
 * 为什么不能写死 `dsh-msp`：对端的连接表是**按 node_id 为键**的
 * （`connections[peer_id] = conn`），握手去重还会按
 * `canonical_is_outbound = self.node_id < peer_id` 决定方向。两个进程报同一个 id
 * 时，在对端眼里就是"同一个 peer 的两条连接"，后连的会把先连的关闭 ——
 * 表现是连接抖动、调用随机失败。两个 DSH 窗口、两个 profile、或者同一台机器上
 * 再跑一个 DSH，都会撞上。
 *
 * 默认策略：**每个进程一个随机 id**（`dsh-msp-<8hex>`）。这样并发实例天然互不
 * 相同，不需要持久化，也不会出现"两个 profile 共享同一个身份文件"的坑。
 * 代价是重启后 id 会变 —— 需要稳定身份（比如对端按 id 做白名单或授权）时，
 * 在配置里显式写 `nodeId`。
 */

import { randomBytes } from "node:crypto";

/** node id 文法：^[a-z0-9_-]+$ */
const NODE_ID_RE = /^[a-z0-9_-]+$/;

export const ID_PREFIX = "dsh-msp";

/**
 * 生成一个唯一且合规的 node id。
 * @param {{prefix?: string, random?: (n: number) => Buffer}} [opts]
 * @returns {string}
 */
export function makeNodeId(opts = {}) {
  const prefix = opts.prefix ?? ID_PREFIX;
  const random = opts.random ?? randomBytes;
  const suffix = random(4).toString("hex");
  return `${prefix}-${suffix}`;
}

/**
 * 校验并归一化配置里给的 nodeId；不合法就退回自动生成的那个。
 * @param {unknown} candidate
 * @param {string} fallback
 * @returns {string}
 */
export function resolveNodeId(candidate, fallback) {
  if (typeof candidate !== "string" || !candidate) return fallback;
  const normalized = candidate.trim().toLowerCase();
  if (!NODE_ID_RE.test(normalized)) return fallback;
  if (normalized.length > 64) return fallback;
  return normalized;
}
