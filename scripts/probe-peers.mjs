/**
 * 探测：把发现目录里每个**新鲜**节点连一遍，打印它宣告的工具。
 *
 *     node scripts/probe-peers.mjs
 *
 * 只用来看「本机还有多少能力没被接进来」，不注册任何 DSH 工具。
 */

import { MspPeer } from "../lib/msp.js";

const nodesDir = process.env.MSP_NODES_DIR ?? `${process.env.USERPROFILE}/.msp/nodes`;

// 复用 MspPeer 的目录读取：先用一个假节点列表出所有声明
const probe = new MspPeer({ nodesDir, gatewayId: "__none__" });
const all = probe.listDeclarations();
const fresh = all.filter((d) => d.ageSeconds !== null && d.ageSeconds <= 30 && d.nodeId !== "dsh-msp");

console.log(`发现目录: ${nodesDir}`);
console.log(`声明总数 ${all.length}，新鲜的 ${fresh.length}:`);
for (const d of all) {
  const mark = fresh.includes(d) ? " " : "×";
  console.log(`  ${mark} ${d.nodeId.padEnd(16)} ${d.host}:${d.port}  租约 ${d.ageSeconds}s`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const decl of fresh) {
  const peer = new MspPeer({ nodesDir, gatewayId: decl.nodeId, retryMs: 60_000, callTimeoutMs: 5_000 });
  peer.start();

  const deadline = Date.now() + 4_000;
  while (!peer.connected && Date.now() < deadline) await sleep(50);

  if (!peer.connected) {
    console.log(`\n=== ${decl.nodeId} === 连不上`);
    peer.stop();
    continue;
  }

  const manifest = peer.manifest ?? {};
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const signals = Array.isArray(manifest.signals) ? manifest.signals : [];
  const patterns = Array.isArray(manifest.patterns) ? manifest.patterns : [];
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];

  console.log(`\n=== ${decl.nodeId} ===`);
  console.log(`  能力: ${capabilities.join(",") || "-"}   模式: ${patterns.join(",") || "-"}`);
  console.log(`  工具: ${tools.length} 个${tools.length ? ": " + tools.map((t) => t.name).join(", ") : ""}`);
  if (signals.length) console.log(`  信号: ${signals.map((s) => s.path).join(", ")}`);

  peer.stop();
  await sleep(100);
}

console.log("\n探测结束");
process.exit(0);
