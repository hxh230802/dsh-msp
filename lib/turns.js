/**
 * 会话事件 → 轮次边界。
 *
 * 踩过的坑：`turn/start` / `turn/end` **不是**总线事件名，而是会话事件的 `type`。
 * 宿主总线只发 `session/event`，载荷是 `(session, event)`，且订阅必须带
 * `{ global: true }` 才收得到别的作用域发的事件。照参考实现（whale-pet）对齐：
 *
 *     ctx.on('session/event', (session, event) => tracker.accept(session, event), { global: true })
 *
 * 单独抽出来是为了能单测：事件分派、seq 去重、跨会话隔离、时长缺失。
 */

export function createTurnTracker({ onEnd, now = () => Date.now() } = {}) {
  /** sessionId -> 起始时刻 */
  const starts = new Map();
  /** sessionId -> 已处理的最大 seq（事件流可能重放/重复投递） */
  const seen = new Map();

  return {
    /**
     * @param {{id?: string}|null} session
     * @param {{type?: string, seq?: number, reason?: string}|null} event
     * @returns {"start"|"end"|"ignored"|"duplicate"}
     */
    accept(session, event) {
      const sessionId = typeof session?.id === "string" ? session.id : "";
      if (!sessionId || !event || typeof event.type !== "string") return "ignored";

      // 去重：同一会话里 seq 单调递增，重放/重复投递直接丢
      if (Number.isSafeInteger(event.seq)) {
        const last = seen.get(sessionId) ?? -1;
        if (event.seq <= last) return "duplicate";
        seen.set(sessionId, event.seq);
      }

      if (event.type === "turn/start") {
        starts.set(sessionId, now());
        return "start";
      }

      if (event.type === "turn/end") {
        const startedAt = starts.get(sessionId);
        starts.delete(sessionId);
        // 没等到 turn/start 时返回 null（"未知"），不要伪装成 0
        const ms = startedAt === undefined ? null : Math.max(0, now() - startedAt);
        onEnd?.({
          sessionId,
          ms,
          reason: typeof event.reason === "string" ? event.reason : "",
        });
        return "end";
      }

      return "ignored";
    },

    /** 诊断用：当前在途会话数与已见会话数 */
    stats() {
      return { inflight: starts.size, sessions: seen.size };
    },
  };
}
