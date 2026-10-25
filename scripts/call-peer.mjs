/**
 * 命令行调一个 MSP 节点的工具（不需要 DSH、不需要重启）。
 *
 *     node scripts/call-peer.mjs <nodeId> --schema            # 看某节点的工具与参数
 *     node scripts/call-peer.mjs <nodeId> <tool> '{"k":"v"}' # 直接调用
 *
 * 例：
 *     node scripts/call-peer.mjs notchpeninsula --schema
 *     node scripts/call-peer.mjs notchpeninsula notify '{"title":"hi","body":"from msp"}'
 */

import { MspPeer } from "../lib/msp.js";

const nodesDir = process.env.MSP_NODES_DIR ?? `${process.env.USERPROFILE}/.msp/nodes`;
const [nodeId, maybeTool, maybeArgs] = process.argv.slice(2);

if (!nodeId) {
  console.error("用法: node scripts/call-peer.mjs <nodeId> [--schema | <tool> '<json>']");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const peer = new MspPeer({ nodesDir, gatewayId: nodeId, retryMs: 60_000, callTimeoutMs: 15_000 });
peer.start();

const deadline = Date.now() + 5_000;
while (!peer.connected && Date.now() < deadline) await sleep(50);

if (!peer.connected) {
  console.error(`连不上 ${nodeId}（节点没在跑，或声明已过期）`);
  process.exit(1);
}

const tools = peer.tools;

if (!maybeTool || maybeTool === "--schema") {
  console.log(`${nodeId} 的工具（${tools.length} 个）:`);
  for (const t of tools) {
    console.log(`\n  ${t.name}`);
    if (t.description) console.log(`    ${t.description}`);
    const schema = t.inputSchema ?? {};
    const props = schema.properties ?? {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [key, spec] of Object.entries(props)) {
      const bits = [spec?.type ?? "any"];
      if (spec?.enum) bits.push(`enum: ${spec.enum.join("|")}`);
      if (spec?.minimum !== undefined || spec?.maximum !== undefined) {
        bits.push(`范围 ${spec.minimum ?? "-"}..${spec.maximum ?? "-"}`);
      }
      if (spec?.default !== undefined) bits.push(`默认 ${JSON.stringify(spec.default)}`);
      console.log(`      ${required.has(key) ? "*" : " "} ${key}: ${bits.join(", ")}`);
    }
  }
  peer.stop();
  process.exit(0);
}

let args = {};
if (maybeArgs) {
  try {
    args = JSON.parse(maybeArgs);
  } catch (err) {
    console.error(`参数不是合法 JSON: ${err.message}`);
    process.exit(2);
  }
}

const result = await peer.callTool(maybeTool, args);
peer.stop();

if (result.error) {
  console.error("失败:", result.error);
  process.exit(1);
}
console.log(JSON.stringify(result.structuredContent ?? result.content, null, 2));
process.exit(0);
