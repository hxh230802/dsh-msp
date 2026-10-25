/**
 * 极简 MSP 客户端（零依赖）——只做「连上网关、列工具、调工具」。
 *
 * 为什么不引 msp-ts：插件会被装进 `~/.dsh/profiles/<p>/node_modules`，
 * 而 msp-ts 还没发布。插件自带 ~200 行客户端比维护一条安装路径更可靠，
 * 且这几条线格式规则已经在 msp-ts 的互通测试里验证过。
 *
 * 线格式（与 msp-py / msp-ts 一致）：
 *   - 4 字节大端长度前缀 + UTF-8 JSON
 *   - Signal 恒输出 8 个顶层字段，None 写成 null
 *   - 握手：HELLO{payload.manifest} → ACK{payload.manifest}
 *   - 调用：tool_call{payload:{tool,args}, reqid} → tool_result{payload:{content,structuredContent|error}, reqid}
 *   - 探活：收到 ping 必须回 pong，否则 45s 后被网关判死
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const HELLO = "hello";
const ACK = "ack";
const TOOL_CALL = "tool_call";
const TOOL_RESULT = "tool_result";
const MANIFEST_UPDATE = "manifest_update";
const PING = "ping";
const PONG = "pong";
const ERROR = "error";

const STALE_AFTER_MS = 30_000;

function makeSignal(type, source, opts = {}) {
  return {
    type,
    source,
    pattern: null,
    target: opts.target ?? null,
    path: opts.path ?? null,
    reqid: opts.reqid ?? null,
    payload: opts.payload ?? {},
    timestamp: Date.now() / 1000,
  };
}

function encode(sig) {
  return Buffer.from(JSON.stringify(sig), "utf-8");
}

function decode(buf) {
  return JSON.parse(buf.toString("utf-8"));
}

class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > 64 * 1024 * 1024) throw new Error(`帧长度超限: ${len}`);
      if (this.buf.length < 4 + len) break;
      out.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

function frame(data) {
  const body = Buffer.from(data);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 空但合法的 manifest（我们只是调用方，不宣告工具）。 */
function minimalManifest() {
  return {
    version: 0,
    patterns: ["msp/request-reply"],
    patternMetadata: {},
    capabilities: ["req"],
    signals: [],
    tools: [],
    resources: [],
    prompts: [],
    clientCapabilities: { sampling: false, elicitation: false, roots: false },
  };
}

export class MspPeer {
  /**
   * @param {object} opts
   * @param {string} opts.nodesDir 共享发现目录
   * @param {string} opts.gatewayId 网关节点的 node_id
   * @param {string} [opts.nodeId] 本客户端自称的 node_id
   * @param {(manifest: object) => void} [opts.onManifest] 每次拿到/更新清单
   * @param {(state: string, detail?: string) => void} [opts.onState] connected/disconnected/error
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor(opts) {
    this.nodesDir = opts.nodesDir;
    this.gatewayId = opts.gatewayId;
    /** 固定端点：给了就不再从声明文件里找（多对端模式用） */
    this.endpoint = opts.endpoint ?? null;
    this.nodeId = opts.nodeId ?? "dsh-msp";
    this.onManifest = opts.onManifest ?? (() => {});
    this.onState = opts.onState ?? (() => {});
    this.onError = opts.onError ?? (() => {});
    this.callTimeoutMs = opts.callTimeoutMs ?? 30_000;
    this.retryMs = opts.retryMs ?? 3_000;

    this.manifest = null;
    this.connected = false;
    this._sock = null;
    this._decoder = null;
    this._pending = new Map();
    this._counter = 0;
    this._running = false;
    this._timer = null;
  }

  get tools() {
    const tools = this.manifest?.tools;
    return Array.isArray(tools) ? tools : [];
  }

  /** 从共享目录里读网关声明；过期（30s 未续租）视为不存在。 */
  readDeclaration() {
    if (this.endpoint) return this.endpoint;
    const file = path.join(this.nodesDir, `${this.gatewayId}.json`);
    let decl;
    try {
      decl = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
    const addr = decl?.endpoint?.address;
    if (!addr?.host || !addr?.port) return null;
    if (typeof decl.timestamp === "number"
      && Date.now() - decl.timestamp * 1000 > STALE_AFTER_MS) return null;
    return { host: String(addr.host), port: Number(addr.port) };
  }

  /** 列出发现目录里的所有节点（只读声明，不连接）。 */
  listDeclarations() {
    let files;
    try {
      files = fs.readdirSync(this.nodesDir);
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const decl = JSON.parse(fs.readFileSync(path.join(this.nodesDir, f), "utf-8"));
        if (typeof decl?.node_id !== "string") continue;
        out.push({
          nodeId: decl.node_id,
          host: decl?.endpoint?.address?.host ?? "",
          port: decl?.endpoint?.address?.port ?? 0,
          ageSeconds: typeof decl.timestamp === "number"
            ? Math.max(0, Math.round(Date.now() / 1000 - decl.timestamp)) : null,
        });
      } catch {
        /* 原子替换的中间态 / 坏文件 */
      }
    }
    return out.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }

  start() {
    if (this._running) return;
    this._running = true;
    void this._loop();
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._destroy("节点已停止");
  }

  async _loop() {
    while (this._running) {
      if (!this._sock) {
        try {
          await this._connect();
        } catch (err) {
          this.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      if (!this._running) break;
      await sleep(this.retryMs);
    }
  }

  async _connect() {
    const addr = this.readDeclaration();
    if (!addr) throw new Error(`未发现网关 ${this.gatewayId}（${this.nodesDir}）`);

    await new Promise((resolve, reject) => {
      const sock = net.connect({ host: addr.host, port: addr.port });
      const decoder = new FrameDecoder();
      let acked = false;

      const onError = (err) => {
        if (!acked) reject(err);
        else this._destroy(`连接错误: ${err.message}`);
      };
      sock.on("error", onError);
      sock.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this._sock = null;
        if (!acked) reject(new Error("连接在握手前关闭"));
        else if (wasConnected) this.onState("disconnected");
      });
      sock.on("data", (chunk) => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch (err) {
          sock.destroy();
          return;
        }
        for (const f of frames) {
          const sig = decode(f);
          if (!acked) {
            if (sig.type !== ACK) {
              sock.destroy();
              reject(new Error(`握手失败，收到 ${sig.type}`));
              return;
            }
            acked = true;
            this._sock = sock;
            this._decoder = decoder;
            this.connected = true;
            this.manifest = sig.payload?.manifest ?? {};
            this.onState("connected");
            this.onManifest(this.manifest);
            resolve();
            continue;
          }
          this._dispatch(sig);
        }
      });

      sock.write(frame(encode(makeSignal(HELLO, this.nodeId, {
        payload: { manifest: minimalManifest() },
      }))));
    });
  }

  _dispatch(sig) {
    switch (sig.type) {
      case TOOL_RESULT:
      case ERROR: {
        const entry = sig.reqid ? this._pending.get(sig.reqid) : null;
        if (!entry) return;
        this._pending.delete(sig.reqid);
        clearTimeout(entry.timer);
        if (sig.type === TOOL_RESULT) {
          entry.resolve({
            content: Array.isArray(sig.payload?.content) ? sig.payload.content : [],
            structuredContent: sig.payload?.structuredContent,
            error: typeof sig.payload?.error === "string" ? sig.payload.error : undefined,
          });
        } else {
          entry.resolve({ content: [], error: String(sig.payload?.message ?? "对端报错") });
        }
        return;
      }
      case MANIFEST_UPDATE:
        this.manifest = sig.payload?.manifest ?? this.manifest;
        this.onManifest(this.manifest);
        return;
      case PING:
        this._send(makeSignal(PONG, this.nodeId, { target: sig.source }));
        return;
      case PONG:
        return;
      default:
        /* signal / 其他：本插件不订阅 */
        return;
    }
  }

  _send(sig) {
    if (!this._sock) throw new Error("未连接");
    this._sock.write(frame(encode(sig)));
  }

  /**
   * 调一个 MSP 工具。错误即值：网络/超时/远端报错都返回 {error}，不抛。
   * @param {string} tool 网关清单里的原始工具名
   * @param {Record<string, unknown>} args
   */
  callTool(tool, args) {
    if (!this._sock) {
      return Promise.resolve({ content: [], error: `未连接网关 ${this.gatewayId}` });
    }
    const reqid = `dsh-${this._counter++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(reqid);
        resolve({ content: [], error: `调用 ${tool} 超时` });
      }, this.callTimeoutMs);
      this._pending.set(reqid, { resolve, timer });
      try {
        this._send(makeSignal(TOOL_CALL, this.nodeId, {
          target: this.gatewayId,
          reqid,
          payload: { tool, args: args ?? {} },
        }));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(reqid);
        resolve({ content: [], error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  _destroy(reason) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.resolve({ content: [], error: reason });
    }
    this._pending.clear();
    if (this._sock) {
      try {
        this._sock.destroy();
      } catch {
        /* 已死 */
      }
      this._sock = null;
    }
    this.connected = false;
  }
}
