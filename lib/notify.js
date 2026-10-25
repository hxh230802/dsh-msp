/**
 * 通知器：把 DSH 的宿主事件翻译成一条 MSP 通知（弹在灵动岛）。
 *
 * 三个场景对应三个事件：
 *   approval/asked        → 有操作等你确认
 *   tools/pre-execute     → 工具名是 ask_user_question 时：有问题等你回答
 *   turn/end              → 一轮任务结束
 *
 * 三条设计约束：
 *   - **绝不阻塞/绝不抛错**：通知是旁路，弹不出来也不能影响审批或工具执行本身。
 *   - **节流**：turn/end 这类高频事件必须限流，否则一次对话能刷出几十条。
 *   - **挑有能力的节点**：优先用配置里指定的节点；它没连上时退回到任意一个
 *     宣告了 `notify` 工具的节点；都没有就安静放弃。
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

const DEFAULTS = {
  notifyNode: "notchpeninsula",
  minIntervalMs: 3000,
  maxBodyChars: 120,
  /** 通知图标：随 content 的 image 块发过去（annotations.role = icon） */
  iconPath: null,
};

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 读一次、缓存 base64 —— 图标是常量，不该每次通知都读盘。 */
function loadIcon(iconPath) {
  if (!iconPath) return null;
  try {
    const data = readFileSync(iconPath).toString("base64");
    const mimeType = MIME_BY_EXT[path.extname(iconPath).toLowerCase()] ?? "image/png";
    return { data, mimeType, chars: data.length };
  } catch {
    return null;
  }
}

/** 从各种可能的 payload 形状里尽力取一句话，取不到就返回空串。 */
export function extractText(value, depth = 0) {
  // 深度上限只是防环，别设太紧：{args:{questions:[{question:"…"}]}} 的字符串在第 4 层
  if (value === null || value === undefined || depth > 6) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractText(item, depth + 1);
      if (text) return text;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of ["question", "text", "title", "message", "summary", "description",
      "prompt", "tool", "name", "reason", "command", "questions", "args", "params"]) {
      if (key in value) {
        const text = extractText(value[key], depth + 1);
        if (text) return text;
      }
    }
  }
  return "";
}

function truncate(text, limit) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * @param {object} opts
 * @param {() => Array<{nodeId: string, connected: boolean, toolMeta: Map<string, {mspName: string}>}>} opts.getPeers
 * @param {object} [opts.config] 见 DEFAULTS
 * @param {(err: Error) => void} [opts.onError] 诊断用
 */
export function createNotifier(opts) {
  const config = { ...DEFAULTS, ...(opts.config ?? {}) };
  const getPeers = opts.getPeers;
  const onError = opts.onError ?? (() => {});
  const lastAt = new Map();
  const icon = loadIcon(config.iconPath);

  /** 从已连接节点里挑一个有 notify 工具能力的。 */
  function pickPeer(preferred) {
    const peers = (getPeers() ?? []).filter((p) => p && p.connected);
    if (!peers.length) return null;
    const hasNotify = (p) => [...(p.toolMeta?.values?.() ?? [])]
      .some((meta) => meta?.mspName === "notify");
    const named = peers.find((p) => p.nodeId === preferred && hasNotify(p));
    if (named) return named;
    return peers.find(hasNotify) ?? null;
  }

  /**
   * 发一条通知。返回是否真的发出去了；任何异常都被吞掉。
   * @param {string} kind "info" | "success" | "warning" | "error"
   */
  async function fire(kind, title, body) {
    try {
      const now = Date.now();
      const key = String(title ?? "");
      const last = lastAt.get(key) ?? 0;
      if (now - last < config.minIntervalMs) return { sent: false, reason: "throttled" };
      lastAt.set(key, now);

      const peer = pickPeer(config.notifyNode);
      if (!peer) return { sent: false, reason: "no-peer-with-notify" };

      const args = {
        kind,
        title: truncate(title, 60) || "DSH",
        body: truncate(body, config.maxBodyChars) || "（无内容）",
      };
      // 图标走 MCP content 块：annotations.role = "icon" 时对端把它当通知图标
      if (icon) {
        args.content = [{
          type: "image",
          data: icon.data,
          mimeType: icon.mimeType,
          annotations: { role: "icon" },
        }];
      }
      const result = await peer.peer.callTool("notify", args);
      if (result?.error) {
        onError(new Error(`notify 失败: ${result.error}`));
        return { sent: false, reason: `call-error: ${result.error}` };
      }
      return { sent: true, reason: "ok", node: peer.nodeId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(err instanceof Error ? err : new Error(message));
      return { sent: false, reason: `exception: ${message}` };
    }
  }

  return { fire, pickPeer, config };
}
