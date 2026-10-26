/**
 * 长任务编排：msp_call_wait 的实现。
 *
 * 模型侧看到的是**同步调用**；host 侧是「信号主路 + 轮询兜底 + 超时转后台」。
 * 纯逻辑（句柄提取、信号归类、轮询探测选择）在 tasks.js，这里只负责接线：
 *   - 调工具拿句柄
 *   - 订阅该节点的信号并喂给 waiter
 *   - 起轮询定时器
 *   - 窗口结束未完成 → 转入后台观察，完成时记一条完成记录（只记一次）
 */

import { extractHandle, pickStatusProbe, TaskWaiter } from "./tasks.js";

const DEFAULTS = {
  waitMs: 25_000,
  pollMs: 2_000,
  backgroundTtlMs: 30 * 60_000,
  backgroundPollMs: 10_000,
};

export function createLongTasks(opts) {
  const prefix = opts.prefix ?? "msp_";
  const config = { ...DEFAULTS, ...(opts.config ?? {}) };
  /** 已学的绑定：`<node>/<tool>` -> {donePath, failPath} */
  const bindings = opts.bindings ?? new Map();
  /** 后台仍在观察的任务 */
  const watching = new Map();
  /** 已完成、还没被告知的记录 */
  const completions = [];
  /** nodeId -> Set<TaskWaiter> */
  const waiters = new Map();

  function remember(nodeId, tool, verdict, via, signalPath) {
    if (via !== "signal" || !signalPath) return; // 轮询结算学不到"哪条信号代表完成"
    const key = `${nodeId}/${tool}`;
    const binding = { ...(bindings.get(key) ?? {}) };
    if (verdict === "done") binding.donePath = signalPath;
    else binding.failPath = signalPath;
    bindings.set(key, binding);
    opts.onPersist?.(bindings);
  }

  function addWaiter(nodeId, waiter) {
    const set = waiters.get(nodeId) ?? new Set();
    set.add(waiter);
    waiters.set(nodeId, set);
    return () => set.delete(waiter);
  }

  /** 信号入口：由 MspPeer 的 onSignal 调过来。 */
  function feedSignal(sig) {
    const set = waiters.get(sig.source);
    if (!set || set.size === 0) return;
    for (const waiter of [...set]) {
      waiter.acceptSignal(sig.path, sig.payload, bindings.get(`${sig.source}/${waiter.tool}`));
    }
  }

  /**
   * 调一个工具并等它完成。
   * @param {{node: string, tool: string, args?: object, waitMs?: number, pollMs?: number, handle?: string}} input
   * @param {{getPeer: (nodeId: string) => {peer: object, tools: Array}|null, onPending?: (record: object) => void}} deps
   */
  async function callAndWait(input, deps) {
    const entry = deps.getPeer(input.node);
    if (!entry) throw new Error(`未连接节点 ${input.node}`);

    const waitMs = Number(input.waitMs ?? config.waitMs);
    const pollMs = Number(input.pollMs ?? config.pollMs);

    // 1) 启动
    const started = await entry.peer.callTool(input.tool, input.args ?? {});
    if (started.error) throw new Error(started.error);

    // 2) 从句柄判断这是不是一个"长任务"；拿不到句柄就当作已经完事
    const found = input.handle ? { handle: String(input.handle), path: "id" } : extractHandle(started);
    if (!found) {
      return {
        status: "completed",
        node: input.node,
        tool: input.tool,
        waited: false,
        result: started.structuredContent ?? started.content,
      };
    }

    const probe = entry.tools?.length ? pickStatusProbe(entry.tools, found.path) : null;
    const pollFn = probe
      ? async (handle) => entry.peer.callTool(probe.name, { [probe.arg]: handle })
      : null;

    const waiter = new TaskWaiter({
      handle: found.handle,
      handleKey: found.path,
      timeoutMs: waitMs,
      pollMs,
      poll: pollFn,
    });
    waiter.tool = input.tool;
    const drop = addWaiter(input.node, waiter);

    // 轮询兜底：信号不来也能发现完成（信号没有保留语义，不能只靠它）
    const tick = pollFn ? setInterval(() => { void waiter.pollOnce(); }, pollMs) : null;

    // 等结算或超时。50ms 粒度足够：信号到达后最迟 50ms 返回
    const startedAt = Date.now();
    while (!waiter.settled && Date.now() - startedAt < waitMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (tick) clearInterval(tick);

    if (waiter.settled) {
      drop();
      const verdict = waiter.settled.verdict;
      remember(input.node, input.tool, verdict, waiter.settled.via, waiter.settled.signalPath);
      const detail = waiter.settled.value ?? (pollFn ? await pollFn(found.handle) : null);
      return {
        status: verdict === "done" ? "completed" : "failed",
        node: input.node,
        tool: input.tool,
        taskId: found.handle,
        via: waiter.settled.via,
        waited: true,
        result: detail?.structuredContent ?? detail?.content ?? null,
      };
    }

    // 3) 超时 → 转后台观察，返回句柄
    const record = {
      node: input.node,
      tool: input.tool,
      taskId: found.handle,
      startedAt: Date.now(),
    };
    const watcher = {
      waiter,
      drop,
      probe,
      deadlineAt: Date.now() + config.backgroundTtlMs,
      tick: setInterval(async () => {
        if (waiter.settled || Date.now() > watcher.deadlineAt) {
          clearInterval(watcher.tick);
          if (!waiter.settled) {
            watching.delete(found.handle);
            drop();
          }
          return;
        }
        await waiter.pollOnce();
        if (waiter.settled) {
          clearInterval(watcher.tick);
          watching.delete(found.handle);
          drop();
          const completion = {
            ...record,
            verdict: waiter.settled.verdict,
            via: waiter.settled.via,
            finishedAt: Date.now(),
            acknowledged: false,
          };
          completions.push(completion);
          if (completions.length > 20) completions.shift();
          remember(input.node, input.tool, waiter.settled.verdict, waiter.settled.via, waiter.settled.signalPath);
          deps.onPending?.(completion);
        }
      }, config.backgroundPollMs),
    };
    watching.set(found.handle, watcher);

    return {
      status: "pending",
      node: input.node,
      tool: input.tool,
      taskId: found.handle,
      waited: true,
      waitedMs: waitMs,
      probe: probe ? `${probe.name}(${probe.arg})` : null,
      hint: "超过等待窗口仍在进行；完成时会记一条完成记录（msp_status 可见）。",
    };
  }

  /** 工具定义工厂。 */
  function toolDefinitions(deps) {
    return [{
      name: `${prefix}call_wait`,
      description:
        "调用一个 MSP 工具并等待它完成：先等该节点的完成信号，信号不来则轮询状态工具兜底；"
        + "超过等待窗口返回 pending 句柄，完成时记一条完成记录。适合下载、构建、渲染这类长任务。",
      parameters: {
        type: "object",
        properties: {
          node: { type: "string", description: "节点 id（msp_status 里的 nodeId）" },
          tool: { type: "string", description: "要调用的工具原始名" },
          args: { type: "object", description: "该工具的参数" },
          waitMs: { type: "number", description: `阻塞等待上限，默认 ${DEFAULTS.waitMs}` },
          pollMs: { type: "number", description: `等待期间轮询间隔，默认 ${DEFAULTS.pollMs}` },
          handle: { type: "string", description: "已知任务句柄（可选，省一次解析）" },
        },
        required: ["node", "tool"],
      },
      execute: async (args) => {
        const value = await callAndWait(args ?? {}, deps);
        return {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
        };
      },
    }];
  }

  return {
    toolDefinitions,
    callAndWait,
    feedSignal,
    completions,
    watching,
    bindings,
    stats: () => ({
      waiting: [...waiters.values()].reduce((n, s) => n + s.size, 0),
      watching: watching.size,
      completions: completions.length,
    }),
  };
}
