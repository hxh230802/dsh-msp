/**
 * 对着真实 MSP 网络跑一次拓扑图：不需要 DSH、不需要重启。
 *
 *     node scripts/live-graph.mjs
 *
 * 用假 ctx 加载插件，等建连落地后调用 /msp/graph 的处理函数，打印节点与边。
 */

import { apply } from "../lib/index.js";

const tools = [];
const routes = [];
const events = [];

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register(def) { tools.push(def); return () => {}; } },
  webServer: { register(route) { routes.push(route); return () => {}; } },
  effect(fn) { fn(); },
  on(name, handler, options) { events.push({ name, handler, options }); },
};

const config = process.env.MSP_NODES_DIR ? { nodesDir: process.env.MSP_NODES_DIR } : {};
apply({ inject: (_, cb) => cb(ctx), on(name, handler) { events.push({ name, handler }); } }, config);

// 等发现 + 建连 + 第一次探测
await new Promise((r) => setTimeout(r, 4000));

function readGraph() {
  const route = routes.find((r) => r.path === "/msp/graph");
  if (!route) {
    console.error("没有注册 /msp/graph");
    process.exit(1);
  }
  let status = 0;
  let body = "";
  route.handler({ method: "GET", headers: {} }, { writeHead(s) { status = s; }, end(b) { body = b; } });
  return { status, graph: JSON.parse(body) };
}

function dump({ status, graph }, tag) {
  console.log(`\n[${tag}] HTTP ${status}  节点 ${graph.stats.nodes} · 在线 ${graph.stats.connected}`);
  console.log(`边：实测 ${graph.stats.observed} · 自报 ${graph.stats.reported} · 推断 ${graph.stats.inferred}`);
  for (const n of graph.nodes) {
    const mark = n.role === "self" ? "我 " : n.connected ? "● " : "○ ";
    console.log(`  ${mark}${n.id}${n.tools?.length ? `  (${n.tools.length} 工具)` : ""}`);
  }
  for (const e of graph.edges) {
    console.log(`  ${e.from} — ${e.to}   [${e.kind}]  ${e.evidence ?? ""}`);
  }
}

dump(readGraph(), "第一次读（探测刚被触发，还没有自报数据）");
await new Promise((r) => setTimeout(r, 2000));
dump(readGraph(), "第二次读（探测结果已回，边应升级为 reported）");

process.exit(0);
