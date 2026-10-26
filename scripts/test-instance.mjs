/** node_id 唯一化：文法、两次生成不同、配置覆盖、非法值退回。 */
import { strict as assert } from "node:assert";

import { makeNodeId, resolveNodeId } from "../lib/instance.js";

const NODE_ID_RE = /^[a-z0-9_-]+$/;

// 1. 默认生成合法且带前缀
for (let i = 0; i < 50; i += 1) {
  const id = makeNodeId();
  assert.match(id, NODE_ID_RE, `不合文法: ${id}`);
  assert.ok(id.startsWith("dsh-msp-"), `缺前缀: ${id}`);
  assert.equal(id.length, "dsh-msp-".length + 8);
}

// 2. 两次生成必须不同（并发实例不能撞）
const ids = new Set(Array.from({ length: 200 }, () => makeNodeId()));
assert.equal(ids.size, 200, "200 次生成出现了重复");

// 3. 配置覆盖：合法值被采纳并小写化
assert.equal(resolveNodeId("My-Dsh-Node", "fallback"), "my-dsh-node");

// 4. 非法值一律退回自动生成的那个
for (const bad of ["", "   ", "has.dot", "有中文", "UPPER SPACE", null, undefined, 42, "a".repeat(80)]) {
  assert.equal(resolveNodeId(bad, "auto-1"), "auto-1", `应退回: ${String(bad)}`);
}

// 5. 注入随机源（可重复测试）
const fixed = makeNodeId({ random: () => Buffer.from([0xde, 0xad, 0xbe, 0xef]) });
assert.equal(fixed, "dsh-msp-deadbeef");

console.log("node_id OK：文法 / 唯一性(200) / 配置覆盖 / 非法退回 / 可注入随机源");
