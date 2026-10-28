/**
 * 拓扑图：把"我知道的东西"整理成节点 + 边，并**标清每条边是怎么来的**。
 *
 * MSP 没有 gossip：一个节点只看得见自己的边，`peer_manifest` 里也没有连接列表。
 * 所以图里的边只有三种出处，混在一起画就是在骗自己：
 *
 *   observed —— 我们自己连上的（真凭实据）
 *   reported —— 对端自己报出来的（它有 peers/ping 之类的工具，回了连接列表）
 *   inferred —— 推断：都在同一个发现目录里、都连上了我们，那它们大概率也互连
 *
 * 纯函数，便于单测；真正取数在 index.js。
 */

const PEER_PROBE_TOOL = /^(ping|status|info|health|peers|topology)$/i;

/** 从对端的任意返回里找"它的连接列表"。找不到就返回 null。 */
export function extractPeerList(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const key of ["peers", "connections", "connected", "neighbors", "neighbours"]) {
    const v = value[key];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
    // 有的是 [{id}] 这种
    if (Array.isArray(v) && v.every((x) => x && typeof x === "object")) {
      const ids = v.map((x) => x.id ?? x.nodeId ?? x.peer).filter((x) => typeof x === "string");
      if (ids.length === v.length) return ids;
    }
  }
  for (const v of Object.values(value)) {
    if (v && typeof v === "object") {
      const hit = extractPeerList(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** 挑一个可以安全地问"你连了谁"的工具（只按名字，不做副作用猜测）。 */
export function pickProbeTool(tools) {
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = String(tool?.name ?? tool?.mspName ?? "");
    if (!PEER_PROBE_TOOL.test(name)) continue;
    const props = tool?.inputSchema?.properties ?? {};
    const required = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
    // 只挑无必填参数的，免得为了探测去编参数
    if (required.length === 0 || Object.keys(props).length === 0) return name;
  }
  return null;
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * @param {object} input
 * @param {string} input.selfId 本节点 id
 * @param {Array<{nodeId: string, connected: boolean, tools?: Array, leaseAge?: number|null}>} input.peers
 * @param {Array<{nodeId: string, ageSeconds?: number|null}>} [input.discovered] 发现目录里的声明
 * @param {Map<string, string[]>} [input.hints] 对端 id → 它自称连着的对端
 * @returns {{nodes: Array, edges: Array, stats: object}}
 */
export function buildGraph(input) {
  const selfId = input.selfId;
  const peers = Array.isArray(input.peers) ? input.peers : [];
  const discovered = Array.isArray(input.discovered) ? input.discovered : [];
  const hints = input.hints ?? new Map();

  const nodes = [{ id: selfId, role: "self", connected: true, tools: [], leaseAge: 0 }];
  const edges = [];
  const seen = new Set();

  const addEdge = (from, to, kind, evidence) => {
    if (from === to) return;
    const key = pairKey(from, to);
    const existing = edges.find((e) => pairKey(e.from, e.to) === key);
    if (existing) {
      // 证据更强的赢：observed > reported > inferred
      const rank = { observed: 3, reported: 2, inferred: 1 };
      if (rank[kind] > rank[existing.kind]) Object.assign(existing, { kind, evidence });
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind, evidence });
  };

  const connected = new Set();
  for (const peer of peers) {
    if (!peer?.nodeId || peer.nodeId === selfId) continue;
    const isConnected = peer.connected === true;
    if (isConnected) connected.add(peer.nodeId);
    nodes.push({
      id: peer.nodeId,
      role: isConnected ? "peer" : "known",
      connected: isConnected,
      tools: Array.isArray(peer.tools) ? peer.tools.map((t) => t.mspName ?? t.name ?? t) : [],
      leaseAge: peer.leaseAge ?? null,
      endpoint: peer.endpoint ?? null,
    });
    addEdge(selfId, peer.nodeId, isConnected ? "observed" : "inferred",
      isConnected ? "我们的连接" : "目录里有声明，还没连上");
  }

  // 目录里有、但连不上的节点（比如端口不通）
  const known = new Set(nodes.map((n) => n.id));
  for (const decl of discovered) {
    if (!decl?.nodeId || known.has(decl.nodeId)) continue;
    known.add(decl.nodeId);
    nodes.push({
      id: decl.nodeId,
      role: "known",
      connected: false,
      tools: [],
      leaseAge: decl.ageSeconds ?? null,
    });
  }

  // 对端之间：有自报就以自报为准，没有才推断。
  //
  // 这里有个反直觉的点：自报**既能加边也能否边**。两个懒节点（都不主动拨）
  // 其实互不相连，如果只按"同目录 + 都连上我们"去推断，会凭空多出边来。
  // 所以只要这一对里有一方报出了自己的连接集，就以它为准：
  // 它没提到对方 = 它们没连上。
  const ids = [...connected];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      const aReported = hints.has(a);
      const bReported = hints.has(b);
      const aKnows = aReported && (hints.get(a) ?? []).includes(b);
      const bKnows = bReported && (hints.get(b) ?? []).includes(a);

      if (aKnows || bKnows) {
        addEdge(a, b, "reported", aKnows && bKnows ? "双方都自称相连" : "一方自报相连");
      } else if (aReported || bReported) {
        // 有人自报了却没说这条 → 它们确实没连上，不画边
        continue;
      } else {
        addEdge(a, b, "inferred", "同目录且都连上了我们（推断）");
      }
    }
  }

  const count = (kind) => edges.filter((e) => e.kind === kind).length;
  return {
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      connected: nodes.filter((n) => n.connected).length,
      observed: count("observed"),
      reported: count("reported"),
      inferred: count("inferred"),
    },
  };
}
