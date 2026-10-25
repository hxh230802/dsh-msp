/** host 路由自测：假 req/res 直接驱动 makeRoutes，不需要起 DSH。 */
import { strict as assert } from "node:assert";

import { makeRoutes } from "../lib/routes.js";

const state = {
  nodesDir: "/tmp/nodes",
  peers: [{ nodeId: "notchpeninsula", key: "notchpeninsula", connected: true,
            endpoint: { host: "127.0.0.1", port: 1 },
            tools: [{ dshName: "msp_notchpeninsula_ping", mspName: "ping", description: "", params: [] }] }],
  calls: [{ at: 1, nodeId: "notchpeninsula", tool: "ping", dshName: "msp_notchpeninsula_ping", ok: true, ms: 3 }],
  discovered: [],
  policy: { include: [], exclude: [], maxPeers: 16 },
  notify: { approval: true, question: true, turnEnd: false },
};

let lastToggle = null;
let lastNotify = null;
const routes = makeRoutes({
  getState: () => state,
  setNodeEnabled: (nodeId, enabled) => { lastToggle = [nodeId, enabled]; return true; },
  setNotify: (key, enabled) => {
    if (!["approval", "question", "turnEnd"].includes(key)) return false;
    state.notify[key] = enabled;
    lastNotify = [key, enabled];
    return true;
  },
});

const byPath = new Map(routes.map((r) => [r.path, r]));
assert.ok(byPath.has("/msp/state"));
assert.ok(byPath.has("/msp/node"));
assert.ok(byPath.has("/msp/notify"));
for (const r of routes) assert.equal(r.kind, "exact");

function fakeRes() {
  return {
    status: 0, headers: null, body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

function fakeReq({ method, headers = {}, body = null }) {
  const handlers = {};
  return {
    method, headers,
    on(event, cb) { (handlers[event] ||= []).push(cb); return this; },
    destroy() {},
    flush() {
      if (body !== null) for (const cb of handlers.data || []) cb(Buffer.from(body));
      for (const cb of handlers.end || []) cb();
    },
  };
}

{
  const res = fakeRes();
  byPath.get("/msp/state").handler(fakeReq({ method: "GET" }), res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.peers.length, 1);
  assert.equal(body.peers[0].tools[0].mspName, "ping");
  assert.equal(res.headers["cache-control"], "no-store");
}

{
  const res = fakeRes();
  byPath.get("/msp/state").handler(fakeReq({ method: "POST" }), res);
  assert.equal(res.status, 405);
}

{
  const res = fakeRes();
  const req = fakeReq({ method: "POST", headers: { "content-type": "application/json" },
                        body: JSON.stringify({ nodeId: "notchpeninsula", enabled: false }) });
  const done = byPath.get("/msp/node").handler(req, res);
  req.flush();
  await done;
  assert.equal(res.status, 200);
  assert.deepEqual(lastToggle, ["notchpeninsula", false]);
  assert.equal(JSON.parse(res.body).ok, true);
}

{
  const res = fakeRes();
  const req = fakeReq({ method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  const done = byPath.get("/msp/node").handler(req, res);
  req.flush();
  await done;
  assert.equal(res.status, 415);
}

{
  const res = fakeRes();
  const req = fakeReq({ method: "POST", headers: { "content-type": "application/json" },
                        body: JSON.stringify({ nodeId: "x" }) });
  const done = byPath.get("/msp/node").handler(req, res);
  req.flush();
  await done;
  assert.equal(res.status, 400);
}

// POST /msp/notify：{key, enabled}
{
  const res = fakeRes();
  const req = fakeReq({ method: "POST", headers: { "content-type": "application/json" },
                        body: JSON.stringify({ key: "turnEnd", enabled: true }) });
  const done = byPath.get("/msp/notify").handler(req, res);
  req.flush();
  await done;
  assert.equal(res.status, 200);
  assert.deepEqual(lastNotify, ["turnEnd", true]);
  assert.equal(JSON.parse(res.body).notify.turnEnd, true);
}

// POST /msp/notify：对象形式 {approval:false}
{
  const res = fakeRes();
  const req = fakeReq({ method: "POST", headers: { "content-type": "application/json" },
                        body: JSON.stringify({ approval: false }) });
  const done = byPath.get("/msp/notify").handler(req, res);
  req.flush();
  await done;
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).notify.approval, false);
}

// 未知开关 → 400
{
  const res = fakeRes();
  const req = fakeReq({ method: "POST", headers: { "content-type": "application/json" },
                        body: JSON.stringify({ key: "nope", enabled: true }) });
  const done = byPath.get("/msp/notify").handler(req, res);
  req.flush();
  await done;
  assert.equal(res.status, 400);
}

console.log("host 路由 OK：state 200 / 405 / node 200 / 415 / 400 / notify 200·200·400");
