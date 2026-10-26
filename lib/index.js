/**
 * dsh-msp —— 把本机 MSP 网络上**每个**节点的工具暴露成 DSH 工具。
 *
 *     agent → ctx.tools.register → MSP/TCP → 各节点（网关再往下挂设备）
 *
 * 与前版的区别：不再只连网关一个节点，而是按发现目录里的**租约**跟踪所有新鲜
 * 节点，每个节点一条连接、一套工具名前缀 `msp_<节点>_<工具>`；节点租约过期或
 * 下线就把它那组工具摘掉。
 *
 * 三个刻意的取舍：
 *   - **工具名带节点前缀**：两个节点都叫 `ping` 也不会撞；前缀由节点 id 归一化而来。
 *   - **断开不等于摘除**：socket 断了工具仍在（否则模型手里的工具名会跳变），
 *     调用会明确返回「未连接」；只有租约过期（真没了）才摘。
 *   - **不订阅信号**：MSP 广播走 `signal`，本插件只做 request-reply，收到即忽略。
 */

import * as os from "node:os";
import * as path from "node:path";

import { MspPeer } from "./msp.js";
import { makeRoutes } from "./routes.js";
import { createNotifier, extractText } from "./notify.js";
import { defaultPrefs, loadPrefs, prefsPath, savePrefs, NOTIFY_KEYS } from "./prefs.js";
import { createTurnTracker } from "./turns.js";
import { makeNodeId, resolveNodeId } from "./instance.js";
import { createLongTasks } from "./longtask.js";
import { bindingsPath, loadBindings, saveBindings } from "./bindings.js";

export const name = "dsh-msp";

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
  includeNodes: [],       // 非空 = 只连这些（白名单）
  excludeNodes: [],       // 黑名单
  toolPrefix: "msp_",
  discoveryMs: 3_000,
  callTimeoutMs: 30_000,
  retryMs: 3_000,
  staleAfterMs: 30_000,
  maxPeers: 16,
  nodeId: null,
  verbose: false,
  // 通知：把"需要你"的瞬间弹到灵动岛（MSP notify）
  notifyNode: "notchpeninsula",
  notifyIcon: true,
  notifyIconPath: null,
  notifyMinIntervalMs: 3000,
  notifyOnApproval: true,
  notifyOnQuestion: true,
  notifyOnTurnEnd: true,
  turnEndMinMs: 20_000,
  // 长任务：msp_call_wait 的默认节奏
  callWaitMs: 25_000,
  callWaitPollMs: 2_000,
  backgroundTtlMs: 30 * 60_000,
  backgroundPollMs: 10_000,
};

/**
 * 本进程的 MSP node_id。写死会让并发实例在对端撞成同一个 peer（连接互相踢掉），
 * 所以默认每个进程随机一个，配置可显式覆盖成稳定 id。
 */
const SELF_ID = resolveNodeId(process.env.MSP_NODE_ID, makeNodeId());

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

/** 节点 id → 工具名前缀片段（规范里是 `[a-z0-9_-]`，但目录里可能有人手写点号）。 */
function sanitizeKey(nodeId) {
  const key = String(nodeId).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return key || "node";
}

function renderValue(value, fallbackName) {
  if (value?.structuredContent !== undefined) {
    return JSON.stringify(value.structuredContent, null, 2);
  }
  const blocks = Array.isArray(value?.content) ? value.content : [];
  const parts = blocks.map((b) => (b && typeof b === "object" && typeof b.text === "string"
    ? b.text : JSON.stringify(b)));
  return parts.join("\n") || `(${fallbackName} 无输出)`;
}

export function apply(root, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...rawConfig };
  /** 配置里的 nodeId 优先；不合法则退回自动生成的那个（保证永远合规且唯一） */
  const selfId = resolveNodeId(config.nodeId, SELF_ID);
  const nodesDir = expandHome(config.nodesDir);
  const prefix = config.toolPrefix;
  const include = new Set(config.includeNodes ?? []);
  const exclude = new Set(config.excludeNodes ?? []);
  const staleSeconds = config.staleAfterMs / 1000;

  const startedAt = Date.now();
  /** 最近的工具调用（给 UI 的"动向"用），只留尾部 */
  const calls = [];
  function record(entry) {
    calls.push(entry);
    if (calls.length > 200) calls.splice(0, calls.length - 200);
  }

  /**
   * host 半端与 UI 之间的唯一接口。UI 通过 /msp/state 读它、/msp/node 改它，
   * 所以这里只暴露数据与一个动作，不让路由直接摸内部结构。
   */
  /** 通知器：tools 注入完成后才拿得到 peer 表，所以用引用占位 */
  const notifierRef = { current: null };
  /** 长任务等待器：同上，peer 表就绪后才建 */
  const longTasksRef = { current: null };
  /** 通知开关：配置文件是种子，用户点过之后以持久化文件为准 */
  const prefsFile = prefsPath();
  const notifyPrefs = loadPrefs(prefsFile, defaultPrefs(config));

  /** 事件钩子在注入块之外，需要一份可打日志的 ctx */
  const hostCtxRef = { current: null };
  /** 每种事件只在首次命中时把 payload 形状打出来，便于对不准字段时校准 */
  const seenEvents = new Set();

  /**
   * 钩子命中计数 + 最近一次通知结果。
   * 为什么不用日志诊断：日志要开 verbose、要翻文件；把计数放进 /msp/state，
   * 用一行 curl 就能看出"事件到底有没有触发、通知卡在哪一步"。
   */
  const hookStats = { sessionEvent: 0, approval: 0, question: 0, turnStart: 0, turnEnd: 0, lastTurnMs: null };
  let lastNotify = null;

  /** 一轮的起止由 tracker 按会话维护（多会话并行也不串） */
  const turnTracker = createTurnTracker({
    onEnd: ({ ms, reason }) => {
      hookStats.turnEnd += 1;
      hookStats.lastTurnMs = ms;
      if (!enabled("turnEnd")) return;
      const suffix = reason ? `（${reason}）` : "";
      if (ms === null) {
        // 没等到 turn/start：时长未知也要弹，不能静默吞掉（踩过）
        fire("success", "DSH 这一轮结束了", `时长未知：没收到 turn/start${suffix}`, "turnEnd");
        return;
      }
      if (ms >= config.turnEndMinMs) {
        fire("success", "DSH 任务完成", `这一轮用了 ${Math.round(ms / 1000)} 秒${suffix}`, "turnEnd");
      }
    },
  });

  const api = {
    ready: false,
    /** 工具注册失败的原因：放进 /msp/state，省得去翻宿主日志 */
    registrationErrors: [],
    getState: () => ({ peers: [], calls: [], discovered: [], policy: { include: [], exclude: [] } }),
    setNodeEnabled: () => false,
    setNotify: () => false,
  };

  root.inject(["tools"], (ctx) => {
    /** peerKey -> { nodeId, key, endpoint, peer, disposers: Map<dshName, dispose> } */
    const peers = new Map();
    /** 元工具单独一张表——它不来自任何清单，混进 peers 会被 diff 误摘（踩过）。 */
    const metaDisposers = new Map();
    let discoveryTimer = null;
    let stopped = false;

    const scanner = new MspPeer({ nodesDir, gatewayId: "__scan__" });

    // ------------------------------------------------------------------
    // 单个节点的工具同步
    // ------------------------------------------------------------------

    function syncPeerTools(entry, manifest) {
      const wanted = new Map();
      for (const tool of Array.isArray(manifest?.tools) ? manifest.tools : []) {
        if (!tool?.name) continue;
        // 节点自己的工具名可能已经带了自己的前缀（如 notchpeninsula_hellomsp_echo），
        // 这里避免拼成 msp_notchpeninsula_notchpeninsula_...
        const local = tool.name.startsWith(`${entry.key}_`)
          ? tool.name : `${entry.key}_${tool.name}`;
        wanted.set(`${prefix}${local}`, tool);
      }

      for (const [dshName, dispose] of [...entry.disposers]) {
        if (wanted.has(dshName)) continue;
        try {
          dispose?.();
        } catch {
          /* 已摘除 */
        }
        entry.disposers.delete(dshName);
      }

      for (const [dshName, tool] of wanted) {
        if (entry.disposers.has(dshName)) continue;
        entry.toolMeta.set(dshName, {
          mspName: tool.name,
          description: tool.description ?? "",
          params: Object.keys(tool.inputSchema?.properties ?? {}),
        });
        try {
          entry.disposers.set(dshName, ctx.tools.register({
            name: dshName,
            description: tool.description || `${tool.name}（来自 MSP 节点 ${entry.nodeId}）`,
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
            output: {
              schema: OUTPUT_SCHEMA,
              render: (_args, value) => [{ type: "text", text: renderValue(value, tool.name) }],
            },
            execute: async (args) => {
              const t0 = Date.now();
              const result = await entry.peer.callTool(tool.name, args ?? {});
              record({
                at: Date.now(),
                nodeId: entry.nodeId,
                tool: tool.name,
                dshName,
                ok: !result.error,
                error: result.error ?? null,
                ms: Date.now() - t0,
              });
              if (result.error) throw new Error(result.error);
              const value = {
                content: result.content.length > 0
                  ? result.content
                  : [{ type: "text", text: renderValue(result, tool.name) }],
              };
              if (result.structuredContent !== undefined) {
                value.structuredContent = result.structuredContent;
              }
              return value;
            },
          }));
        } catch (err) {
          log(ctx, "warn", `注册 ${dshName} 失败: ${err.message}`);
        }
      }

      for (const dshName of [...entry.toolMeta.keys()]) {
        if (!wanted.has(dshName)) entry.toolMeta.delete(dshName);
      }
      if (wanted.size > 0) {
        log(ctx, "info", `${entry.nodeId}: 暴露 ${wanted.size} 个工具（${prefix}${entry.key}_*）`);
      }
    }

    // ------------------------------------------------------------------
    // 节点生命周期
    // ------------------------------------------------------------------

    function allocateKey(nodeId) {
      const base = sanitizeKey(nodeId);
      const taken = new Set(peers.keys());
      if (!taken.has(base)) return base;
      let i = 2;
      while (taken.has(`${base}_${i}`)) i += 1;
      return `${base}_${i}`;
    }

    function addPeer(decl) {
      const key = allocateKey(decl.nodeId);
      const entry = {
        nodeId: decl.nodeId,
        key,
        endpoint: { host: decl.host, port: decl.port },
        disposers: new Map(),
        toolMeta: new Map(),
        peer: null,
      };
      entry.peer = new MspPeer({
        nodesDir,
        gatewayId: decl.nodeId,
        endpoint: entry.endpoint,
        nodeId: selfId,
        callTimeoutMs: config.callTimeoutMs,
        retryMs: config.retryMs,
        onManifest: (manifest) => syncPeerTools(entry, manifest),
        // 信号汇入长任务等待器（msp_call_wait 的"主路"）
        onSignal: (sig) => longTasksRef.current?.feedSignal(sig),
        onState: (state) => {
          if (state === "connected") {
            log(ctx, "info", `已连上 ${entry.nodeId}（工具前缀 ${prefix}${key}_）`);
          } else if (state === "disconnected") {
            log(ctx, "warn", `${entry.nodeId} 断开，重试中`);
          }
        },
        onError: (err) => {
          if (config.verbose) log(ctx, "info", `${entry.nodeId}: ${err.message}`);
        },
      });
      peers.set(key, entry);
      entry.peer.start();
      return entry;
    }

    function dropPeer(key, reason) {
      const entry = peers.get(key);
      if (!entry) return;
      peers.delete(key);
      try {
        entry.peer.stop();
      } catch {
        /* 已停 */
      }
      const count = entry.disposers.size;
      for (const dispose of entry.disposers.values()) {
        try {
          dispose?.();
        } catch {
          /* 已摘除 */
        }
      }
      entry.disposers.clear();
      entry.toolMeta.clear();
      if (count > 0 || config.verbose) {
        log(ctx, "info", `移除 ${entry.nodeId}（${reason}），摘掉 ${count} 个工具`);
      }
    }

    // ------------------------------------------------------------------
    // 发现循环
    // ------------------------------------------------------------------

    function scan() {
      if (stopped) return;
      const declarations = scanner.listDeclarations();
      const fresh = declarations.filter((d) => {
        if (d.nodeId === selfId) return false;
        if (d.ageSeconds === null || d.ageSeconds > staleSeconds) return false;
        if (include.size > 0) return include.has(d.nodeId);
        return !exclude.has(d.nodeId);
      });

      const wanted = new Map(fresh.map((d) => [d.nodeId, d]));

      for (const [key, entry] of [...peers]) {
        if (!wanted.has(entry.nodeId)) dropPeer(key, "租约过期或已下线");
      }

      const known = new Set([...peers.values()].map((e) => e.nodeId));
      for (const [nodeId, decl] of wanted) {
        if (known.has(nodeId)) continue;
        if (peers.size >= config.maxPeers) {
          if (config.verbose) log(ctx, "warn", `已达 maxPeers=${config.maxPeers}，跳过 ${nodeId}`);
          continue;
        }
        addPeer(decl);
      }
    }

    // UI 的数据面：读状态 + 改权限（改完立刻重新 scan，等价于马上连/断）
    api.getState = () => ({
      selfId,
      notify: { ...notifyPrefs },
      notifyIcon: notifierRef.current?.iconInfo?.() ?? null,
      hooks: { ...hookStats },
      longTasks: longTasksRef.current
        ? { ...longTasksRef.current.stats(), completions: longTasksRef.current.completions.slice(-10) }
        : null,
      registrationErrors: api.registrationErrors.slice(-10),
      lastNotify,
      nodesDir,
      startedAt,
      policy: { include: [...include], exclude: [...exclude], maxPeers: config.maxPeers },
      peers: [...peers.values()].map((e) => ({
        nodeId: e.nodeId,
        key: e.key,
        connected: e.peer.connected,
        endpoint: e.endpoint,
        tools: [...e.toolMeta.entries()].map(([dshName, meta]) => ({ dshName, ...meta })),
      })),
      calls: calls.slice(-40),
      discovered: scanner.listDeclarations(),
    });

    api.setNotify = (key, enabled) => {
      if (!NOTIFY_KEYS.includes(key)) return false;
      notifyPrefs[key] = Boolean(enabled);
      savePrefs(prefsFile, notifyPrefs);
      log(ctx, "info", `通知开关 ${key} = ${enabled ? "开" : "关"}`);
      return true;
    };

    api.setNodeEnabled = (nodeId, enabled) => {
      if (enabled) {
        exclude.delete(nodeId);
        if (include.size > 0) include.add(nodeId);
      } else {
        exclude.add(nodeId);
        include.delete(nodeId);
      }
      scan();
      return true;
    };
    notifierRef.current = createNotifier({
      getPeers: () => [...peers.values()].map((e) => ({
        nodeId: e.nodeId,
        connected: e.peer.connected,
        toolMeta: e.toolMeta,
        peer: e.peer,
      })),
      config: {
        notifyNode: config.notifyNode,
        minIntervalMs: config.notifyMinIntervalMs,
        // 默认用 lib/icon.js 里的内联 base64（零 I/O）；
        // notifyIconPath 才去读文件，notifyIcon:false 完全不带图标
        useIcon: config.notifyIcon !== false,
        iconPath: config.notifyIconPath ?? null,
      },
      onError: (err) => { if (config.verbose) log(ctx, "info", err.message); },
    });

    // ------------------------------------------------------------------
    // 长任务：msp_call_wait（信号主路 + 轮询兜底 + 超时转后台）
    // ------------------------------------------------------------------
    const findPeer = (nodeId) => {
      for (const e of peers.values()) {
        if (e.nodeId === nodeId || e.key === nodeId) return { peer: e.peer, tools: e.peer.tools };
      }
      return null;
    };
    const longTasks = createLongTasks({
      prefix,
      config: {
        waitMs: config.callWaitMs,
        pollMs: config.callWaitPollMs,
        backgroundTtlMs: config.backgroundTtlMs,
        backgroundPollMs: config.backgroundPollMs,
      },
      bindings: loadBindings(bindingsPath()),
      onPersist: (map) => saveBindings(bindingsPath(), map),
    });
    longTasksRef.current = longTasks;
    for (const def of longTasks.toolDefinitions({
      getPeer: findPeer,
      onPending: (record) => {
        // 后台完成时复用通知通道（受 notifyOnTurnEnd 之外的开关约束，节流已有）
        fire("success", `${record.node} 任务完成`,
          `${record.tool} ${record.taskId}（${record.verdict === "done" ? "成功" : "失败"}）`, "longTask");
      },
    })) {
      try {
        metaDisposers.set(def.name, ctx.tools.register(def));
      } catch (err) {
        log(ctx, "warn", `注册 ${def.name} 失败: ${err.message}`);
        api.registrationErrors.push({ tool: def.name, error: err.message });
      }
    }

    api.ready = true;

    // ------------------------------------------------------------------
    // 元工具：永远可用，用来解释「为什么没有某个工具」
    // ------------------------------------------------------------------

    const STATUS_NAME = `${prefix}status`;
    try {
      metaDisposers.set(STATUS_NAME, ctx.tools.register({
        name: STATUS_NAME,
        description: "查看 MSP 网络：每个节点的连接状态与已暴露的工具，以及发现目录里的全部节点。",
        parameters: { type: "object", properties: {} },
        output: {
          schema: OUTPUT_SCHEMA,
          render: (_args, value) => [{ type: "text", text: renderValue(value, STATUS_NAME) }],
        },
        execute: async () => {
          const value = {
            nodesDir,
            peers: [...peers.values()].map((e) => ({
              nodeId: e.nodeId,
              key: e.key,
              connected: e.peer.connected,
              endpoint: e.endpoint,
              tools: [...e.disposers.keys()],
            })),
            discovered: scanner.listDeclarations(),
          };
          return {
            content: [{ type: "text", text: renderValue({ structuredContent: value }, STATUS_NAME) }],
            structuredContent: value,
          };
        },
      }));
    } catch (err) {
      log(ctx, "warn", `注册 ${STATUS_NAME} 失败: ${err.message}`);
    }

    scan();
    discoveryTimer = setInterval(scan, config.discoveryMs);
    discoveryTimer.unref?.();

    ctx.effect(() => () => {
      stopped = true;
      if (discoveryTimer) clearInterval(discoveryTimer);
      for (const key of [...peers.keys()]) dropPeer(key, "插件卸载");
      for (const dispose of metaDisposers.values()) {
        try {
          dispose?.();
        } catch {
          /* 已摘除 */
        }
      }
      metaDisposers.clear();
    }, "dsh-msp: 多节点发现与工具");
  });

  // UI 的数据通路。和 tools 分开注入：tools 不可用时页面仍能显示"为什么没工具"。
  root.inject(["webServer"], (ctx) => {
    hostCtxRef.current = ctx;
    const routes = makeRoutes(api);
    for (const route of routes) {
      try {
        ctx.webServer.register(route);
      } catch (err) {
        log(ctx, "warn", `注册路由 ${route.path} 失败: ${err.message}`);
      }
    }
    log(ctx, "info", `已注册 UI 路由: ${routes.map((r) => r.path).join(", ")}`);
  });

  // -------------------------------------------------------------------
  // 通知钩子：三个"需要你"的瞬间
  // -------------------------------------------------------------------
  function enabled(key) {
    return notifyPrefs[key] === true;
  }

  function fire(kind, title, body, source) {
    const notifier = notifierRef.current;
    if (!notifier) {
      lastNotify = { at: Date.now(), kind, title, source, sent: false, reason: "notifier-not-ready" };
      return;
    }
    void notifier.fire(kind, title, body).then((result) => {
      lastNotify = { at: Date.now(), kind, title, source, ...result };
    });
  }

  /** 首次命中某事件时打一行诊断（verbose 才有），用来校准 payload 字段。 */
  function diagnose(event, payload) {
    if (!config.verbose || seenEvents.has(event)) return;
    seenEvents.add(event);
    let shape = "";
    try {
      shape = JSON.stringify(payload ?? null).slice(0, 300);
    } catch {
      shape = "(不可序列化)";
    }
    log(hostCtxRef.current ?? { logger: console }, "info", `事件 ${event} 首次命中: ${shape}`);
  }

  try {
    // ① 需要确认：审批被挂起
    if (config.notifyOnApproval) {
      root.on("approval/asked", (payload) => {
        hookStats.approval += 1;
        if (!enabled("approval")) return;
        diagnose("approval/asked", payload);
        fire("warning", "DSH 需要你确认", extractText(payload) || "有个操作在等你批准", "approval");
      }, { global: true });
    }

    // ② 需要回答：模型调 ask_user_question（这是中间件，必须放行 next()）
    if (config.notifyOnQuestion) {
      root.on("tools/pre-execute", (exec, next) => {
        try {
          const name = String(exec?.name ?? exec?.tool ?? "");
          if (name === "ask_user_question") {
            hookStats.question += 1;
            if (!enabled("question")) return next();
            diagnose("tools/pre-execute:ask_user_question", exec);
            fire("info", "DSH 有个问题等你回答", extractText(exec?.args ?? exec) || "点开对话看问题", "question");
          }
        } catch {
          /* 通知失败绝不影响工具执行 */
        }
        return next();
      }, { global: true });
    }

    // ③ 任务完成：只在"跑了够久"的一轮结束时提醒，避免刷屏
    if (config.notifyOnTurnEnd) {
      // turn/start、turn/end 是**会话事件的 type**，总线事件叫 session/event，
      // 且必须 { global: true } 才收得到别的作用域发的事件（踩过）。
      root.on("session/event", (session, event) => {
        hookStats.sessionEvent += 1;
        if (event?.type === "turn/start") hookStats.turnStart += 1;
        diagnose("session/event", { type: event?.type, seq: event?.seq });
        turnTracker.accept(session, event);
      }, { global: true });
    }
  } catch (err) {
    log({ logger: console }, "warn", `注册通知钩子失败: ${err.message}`);
  }
}
