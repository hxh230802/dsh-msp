/**
 * dsh-msp —— 把 MSP 网关挂载的设备工具暴露成 DSH 工具。
 *
 * 链路：agent → 本插件（ctx.tools.register）→ msp-gateway → 设备（MCP-over-WS）
 *
 * 设计要点：
 *   - **工具集合跟着网关清单走**：网关推 MANIFEST_UPDATE（设备上线/掉线）时，
 *     本插件按名字 diff 增删 DSH 工具，不重启会话。
 *   - **网关不在也能启动**：后台每 retryMs 重试，连上后自动补齐工具。
 *   - **错误即值对外表现为抛错**：DSH 工具契约里失败要 throw，让模型读到原因
 *     而不是把空成功当答案（这是 dsh-ops 的既有约定，跟它保持一致）。
 *   - 零依赖：不做 npm 安装，MSP 客户端在 lib/msp.js 里自带。
 */

import * as os from "node:os";
import * as path from "node:path";

import { MspPeer } from "./msp.js";

export const name = "dsh-msp";

/** 与 dsh-ops 一致的输出值形状（DSH 侧对 structuredContent 的约定）。 */
const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    content: { type: "array", items: {} },
    structuredContent: {},
  },
  required: ["content"],
  additionalProperties: false,
});

const DEFAULT_CONFIG = {
  nodesDir: "~/.msp/nodes",
  gateway: "gateway",
  toolPrefix: "msp_",
  nodeId: "dsh-msp",
  exclude: [],
  callTimeoutMs: 30_000,
  retryMs: 3_000,
  verbose: false,
};

function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function log(ctx, level, message) {
  const logger = ctx?.logger;
  if (typeof logger?.[level] === "function") logger[level](`dsh-msp: ${message}`);
  else if (level === "error") console.error(`dsh-msp: ${message}`);
  else if (level === "warn") console.warn(`dsh-msp: ${message}`);
}

/** 把 MSP 的返回形状渲染成给模型看的文本。 */
function renderValue(value, fallbackName) {
  if (value?.structuredContent !== undefined) {
    return JSON.stringify(value.structuredContent, null, 2);
  }
  const blocks = Array.isArray(value?.content) ? value.content : [];
  const parts = blocks.map((b) => {
    if (b && typeof b === "object" && typeof b.text === "string") return b.text;
    return JSON.stringify(b);
  });
  return parts.join("\n") || `(${fallbackName} 无输出)`;
}

/** 一条 MSP 工具 → 一条 DSH 工具定义。 */
function definitionFor(peer, mspTool, dshName) {
  return {
    name: dshName,
    description: mspTool.description
      || `MSP 工具 ${mspTool.name}（经网关 ${peer.gatewayId} 转发）`,
    parameters: mspTool.inputSchema ?? { type: "object", properties: {} },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: renderValue(value, mspTool.name) }],
    },
    execute: async (args) => {
      const result = await peer.callTool(mspTool.name, args ?? {});
      if (result.error) throw new Error(result.error);
      const value = {
        content: result.content.length > 0
          ? result.content
          : [{ type: "text", text: renderValue(result, mspTool.name) }],
      };
      if (result.structuredContent !== undefined) {
        value.structuredContent = result.structuredContent;
      }
      return value;
    },
  };
}

export function apply(root, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...rawConfig };
  const nodesDir = expandHome(config.nodesDir);
  const prefix = config.toolPrefix;
  const excluded = new Set(config.exclude ?? []);

  // 只注入 tools 服务：插件不碰其它任何东西（最小权限）。
  root.inject(["tools"], (ctx) => {
    /**
     * 设备工具：跟着网关清单 diff，会随设备上下线增删。
     * 元工具（msp_status）必须单独放——它不来自清单，混在一起会被
     * 「清单里没有 = 工具消失」的 diff 逻辑误摘（踩过）。
     */
    const disposers = new Map();
    const metaDisposers = new Map();

    const peer = new MspPeer({
      nodesDir,
      gatewayId: config.gateway,
      nodeId: config.nodeId,
      callTimeoutMs: config.callTimeoutMs,
      retryMs: config.retryMs,
      onManifest: (manifest) => syncTools(manifest),
      onState: (state) => {
        if (state === "connected") log(ctx, "info", `已连上网关 ${config.gateway}`);
        if (state === "disconnected") log(ctx, "warn", `与网关 ${config.gateway} 断开，等待重连`);
      },
      onError: (err) => {
        if (config.verbose) log(ctx, "info", err.message);
      },
    });

    /** 按网关清单 diff：新工具注册、消失的工具摘除。 */
    function syncTools(manifest) {
      const wanted = new Map();
      for (const tool of Array.isArray(manifest?.tools) ? manifest.tools : []) {
        if (!tool?.name || excluded.has(tool.name)) continue;
        wanted.set(prefix + tool.name, tool);
      }

      for (const [dshName, dispose] of [...disposers]) {
        if (wanted.has(dshName)) continue;
        try {
          dispose?.();
        } catch {
          /* 已摘除 */
        }
        disposers.delete(dshName);
      }

      for (const [dshName, tool] of wanted) {
        if (disposers.has(dshName)) continue;
        try {
          disposers.set(dshName, ctx.tools.register(definitionFor(peer, tool, dshName)));
        } catch (err) {
          log(ctx, "warn", `注册工具 ${dshName} 失败: ${err.message}`);
        }
      }

      if (wanted.size > 0) {
        log(ctx, "info", `已暴露 ${wanted.size} 个 MSP 工具: ${[...wanted.keys()].join(", ")}`);
      }
    }

    // 元工具：不依赖设备，永远可用（网关没起时也能用来诊断）。
    const STATUS_NAME = `${prefix}status`;
    try {
      metaDisposers.set(STATUS_NAME, ctx.tools.register({
        name: STATUS_NAME,
        description: "查看 MSP 网关连接状态、已暴露的工具、以及发现目录里的节点。",
        parameters: { type: "object", properties: {} },
        output: {
          schema: OUTPUT_SCHEMA,
          render: (_args, value) => [{ type: "text", text: renderValue(value, STATUS_NAME) }],
        },
        execute: async () => {
          const value = {
            connected: peer.connected,
            gateway: config.gateway,
            nodesDir,
            tools: peer.tools.map((t) => prefix + t.name),
            discovered: peer.listDeclarations(),
          };
          return { content: [{ type: "text", text: renderValue({ structuredContent: value }, STATUS_NAME) }], structuredContent: value };
        },
      }));
    } catch (err) {
      log(ctx, "warn", `注册 ${STATUS_NAME} 失败: ${err.message}`);
    }

    peer.start();

    ctx.effect(() => () => {
      peer.stop();
      for (const group of [disposers, metaDisposers]) {
        for (const dispose of group.values()) {
          try {
            dispose?.();
          } catch {
            /* 已摘除 */
          }
        }
        group.clear();
      }
    }, "dsh-msp: 网关连接与工具");
  });
}
