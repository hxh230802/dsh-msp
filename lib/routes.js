/**
 * host 半端的 HTTP 面：给 UI 读状态、改权限。
 *
 * 路由形状来自 `@deepseek-ai/dsh-host-webserver` 的 WebRoute：
 *   { kind: 'exact', path: '/msp/state', handler(req, res) }
 *
 * 为什么走 HTTP 而不是别的：浏览器半端不能开 TCP，宿主是唯一能碰到 MSP 网络的
 * 进程；同一台机器、同一端口，同源 fetch 即可，不需要 CORS。
 *
 * 这一层刻意做成纯函数（注入 getState/setNodeEnabled），因此可以在 Node 里
 * 直接拿假 req/res 单测，不需要起 DSH。
 */

const API_PREFIX = "/msp";

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body 过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {object} api
 * @param {() => object} api.getState 汇总当前网络状态
 * @param {(nodeId: string, enabled: boolean) => boolean} api.setNodeEnabled 改权限，返回是否成功
 * @returns {Array<{kind: string, path: string, handler: Function}>}
 */
export function makeRoutes(api) {
  const state = {
    kind: "exact",
    path: `${API_PREFIX}/state`,
    handler: (req, res) => {
      if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
      try {
        writeJson(res, 200, { ok: true, ...api.getState() });
      } catch (err) {
        writeJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    },
  };

  const node = {
    kind: "exact",
    path: `${API_PREFIX}/node`,
    handler: async (req, res) => {
      if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return writeJson(res, 415, { ok: false, error: "json-required" });
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return writeJson(res, 400, { ok: false, error: String(err?.message ?? err) });
      }
      const nodeId = body?.nodeId;
      if (typeof nodeId !== "string" || typeof body?.enabled !== "boolean") {
        return writeJson(res, 400, { ok: false, error: "需要 {nodeId: string, enabled: boolean}" });
      }
      try {
        const changed = api.setNodeEnabled(nodeId, body.enabled);
        writeJson(res, 200, { ok: true, changed, ...api.getState() });
      } catch (err) {
        writeJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    },
  };

  const notify = {
    kind: "exact",
    path: `${API_PREFIX}/notify`,
    handler: async (req, res) => {
      if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return writeJson(res, 415, { ok: false, error: "json-required" });
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return writeJson(res, 400, { ok: false, error: String(err?.message ?? err) });
      }
      try {
        // 两种写法都收：{key, enabled} 或 {approval:true, turnEnd:false, ...}
        if (typeof body?.key === "string") {
          const applied = api.setNotify(body.key, Boolean(body.enabled));
          if (!applied) return writeJson(res, 400, { ok: false, error: `未知开关: ${body.key}` });
        } else {
          const entries = Object.entries(body ?? {}).filter(([, v]) => typeof v === "boolean");
          if (entries.length === 0) {
            return writeJson(res, 400, { ok: false, error: "需要 {key, enabled} 或 {approval|question|turnEnd: boolean}" });
          }
          for (const [key, value] of entries) {
            if (!api.setNotify(key, value)) {
              return writeJson(res, 400, { ok: false, error: `未知开关: ${key}` });
            }
          }
        }
        writeJson(res, 200, { ok: true, ...api.getState() });
      } catch (err) {
        writeJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    },
  };

  // 拓扑图：节点 + 边，边带 kind（observed / reported / inferred）——
  // MSP 没有 gossip，一条边是"看到的"还是"猜的"必须能分辨。
  const graph = {
    kind: "exact",
    path: `${API_PREFIX}/graph`,
    handler: (req, res) => {
      if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
      try {
        writeJson(res, 200, { ok: true, ...api.getGraph() });
      } catch (err) {
        writeJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    },
  };

  return [state, node, notify, graph];
}
