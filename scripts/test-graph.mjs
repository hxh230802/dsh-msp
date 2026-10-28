/** 拓扑图构建：观测 / 自报 / 推断 三种边，以及探测工具的选择。 */
import { strict as assert } from "node:assert";

import { buildGraph, extractPeerList, pickProbeTool } from "../lib/graph.js";

const peers = [
  { nodeId: "notchpeninsula", connected: true, tools: [{ mspName: "notify" }], leaseAge: 2 },
  { nodeId: "gd3", connected: true, tools: [{ mspName: "add_task" }], leaseAge: 3 },
  { nodeId: "dead", connected: false, leaseAge: 120 },
];
const discovered = [
  { nodeId: "notchpeninsula", ageSeconds: 2 },
  { nodeId: "gd3", ageSeconds: 3 },
  { nodeId: "dead", ageSeconds: 120 },
  { nodeId: "only-in-dir", ageSeconds: 400 },
];

// 1. 没有自报信息 → 自己的边是 observed，节点之间是 inferred
{
  const g = buildGraph({ selfId: "dsh-msp-1", peers, discovered });
  assert.equal(g.stats.observed, 2, `应有两个自己的连接，实际 ${g.stats.observed}`);
  // 推断的两条：自己↔掉线节点（有声明没连上）＋ 两个在线节点之间
  assert.equal(g.stats.inferred, 2, `推断边数不对: ${JSON.stringify(g.edges.map((e) => [e.from, e.to, e.kind]))}`);
  const peerEdge = g.edges.find(
    (e) => [e.from, e.to].includes("notchpeninsula") && [e.from, e.to].includes("gd3"),
  );
  assert.equal(peerEdge.kind, "inferred");
  // 目录里多出来的节点也要出现，但没有边
  assert.ok(g.nodes.some((n) => n.id === "only-in-dir" && n.connected === false));
  assert.ok(!g.edges.some((e) => [e.from, e.to].includes("only-in-dir")), "孤立节点不该有边");
}

// 2. 对端自报相连 → 那条边升级为 reported
{
  const hints = new Map([["notchpeninsula", ["gd3", "dsh-msp-1"]]]);
  const g = buildGraph({ selfId: "dsh-msp-1", peers, discovered, hints });
  const peerEdge = g.edges.find(
    (e) => [e.from, e.to].includes("notchpeninsula") && [e.from, e.to].includes("gd3"),
  );
  assert.equal(peerEdge.kind, "reported");
  assert.match(peerEdge.evidence, /自报|自称/);
  assert.ok(g.stats.reported >= 1);
}

// 3. 自报的证据不能盖掉自己的观测
{
  const hints = new Map([["gd3", ["notchpeninsula"]]]);
  const g = buildGraph({ selfId: "dsh-msp-1", peers, discovered, hints });
  const selfEdge = g.edges.find((e) => [e.from, e.to].includes("dsh-msp-1") && [e.from, e.to].includes("gd3"));
  assert.equal(selfEdge.kind, "observed");
}

// 4. 自己不能出现在 peers 里（防自环）
{
  const g = buildGraph({ selfId: "gd3", peers, discovered });
  assert.equal(g.nodes.filter((n) => n.id === "gd3" && n.role === "self").length, 1);
  assert.ok(!g.edges.some((e) => e.from === e.to));
}

// 5. 从各种返回形状里挖 peers 列表
{
  assert.deepEqual(extractPeerList({ peers: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(extractPeerList({ data: { connections: ["x"] } }), ["x"]);
  assert.deepEqual(extractPeerList({ peers: [{ id: "p1" }, { id: "p2" }] }), ["p1", "p2"]);
  assert.equal(extractPeerList({ ok: true }), null);
  assert.equal(extractPeerList(null), null);
}

// 6. 只挑无必填参数的探测工具
{
  assert.equal(pickProbeTool([{ name: "ping", inputSchema: { type: "object", properties: {} } }]), "ping");
  assert.equal(
    pickProbeTool([{ name: "get_task", inputSchema: { type: "object", properties: { taskId: {} }, required: ["taskId"] } }]),
    null,
    "有必填参数的不能用来探测",
  );
  assert.equal(pickProbeTool([{ name: "add_task", inputSchema: { type: "object", properties: {} } }]), null);
}

console.log("拓扑图 OK：观测/自报/推断 / 证据优先级 / 自环 / 孤立节点 / peers 提取 / 探测工具选择");
