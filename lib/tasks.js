/**
 * 长任务等待：把「调一个工具 → 等它完成」包装成同步语义。
 *
 * 设计要点（见 README 的「长任务」一节）：
 *   - **不假设信号一定来**。MSP 的广播受发布方 `grant_sub` 约束（同机回环默认放行，
 *     跨机需要授权），而且信号没有保留语义，掉线就永久丢失。所以**轮询是兜底主路**，
 *     信号只是加速手段 —— 于是「不知道订阅哪条信号」退化成性能问题，不是正确性问题。
 *   - **绑不上就学**：先用词法先验（completed/failed 之类的命名），再靠观测确认
 *     （后续事件的 payload 里出现这次调用的句柄即绑定成功）。
 *   - **幂等**：信号与轮询可能同时到达，谁先到用谁，只结算一次。
 */

const HANDLE_KEY_RE = /^(task_?id|taskid|id|handle|job_?id|gid)$/i;
const DONE_RE = /(complet|done|finish|success|ready)/i;
const FAIL_RE = /(fail|error|cancel|abort)/i;

/** 递归判断 payload 里是否出现了这个句柄（字符串或数字相等）。 */
export function matchesHandle(value, handle, depth = 0) {
  if (handle === null || handle === undefined || depth > 6) return false;
  const target = String(handle);
  if (typeof value === "string" || typeof value === "number") return String(value) === target;
  if (Array.isArray(value)) return value.some((v) => matchesHandle(v, handle, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value).some((v) => matchesHandle(v, handle, depth + 1));
  }
  return false;
}

/**
 * 在"成功返回"里找工具自己的失败（很多工具把错误塞进返回值而不是抛错）。
 * 支持三种常见形状：顶层 {error}、数组元素的 {error}、{ok:false, message}。
 * @returns {string|null} 错误描述；没有则 null
 */
export function findEmbeddedError(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;

  const describe = (err) => {
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      return String(err.message ?? err.code ?? JSON.stringify(err));
    }
    return "";
  };

  if (value.error) return describe(value.error) || "工具返回了 error";
  if (value.ok === false) return describe(value.message ?? value.error) || "工具返回 ok:false";

  for (const [key, item] of Object.entries(value)) {
    if (key === "error") continue;
    if (Array.isArray(item)) {
      for (const el of item) {
        const hit = el && typeof el === "object" ? findEmbeddedError(el, depth + 1) : null;
        if (hit) return hit;
      }
    } else if (item && typeof item === "object") {
      const hit = findEmbeddedError(item, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 从工具返回里取句柄。先看 structuredContent 的常见键名，再退化为
 * 「第一个看起来像 id 的标量」。
 * @returns {{handle: string, path: string}|null}
 */
export function extractHandle(result) {
  const value = result?.structuredContent ?? null;
  if (!value || typeof value !== "object") return null;

  for (const [key, v] of Object.entries(value)) {
    if (HANDLE_KEY_RE.test(key) && (typeof v === "string" || typeof v === "number")) {
      const text = String(v);
      if (text) return { handle: text, path: key };
    }
  }
  // 有的实现把任务对象嵌一层（{ task: { id } }）
  for (const v of Object.values(value)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = extractHandle({ structuredContent: v });
      if (nested) return { handle: nested.handle, path: nested.path };
    }
  }
  return null;
}

/**
 * 一条信号对这次等待意味着什么。
 * 先按词法猜（不依赖任何配置），观测确认后由 binding 覆盖。
 * @returns {"done"|"fail"|"other"}
 */
export function classifySignal(signalPath, binding) {
  if (binding?.donePath && signalPath === binding.donePath) return "done";
  if (binding?.failPath && signalPath === binding.failPath) return "fail";
  const tail = String(signalPath).split(".").pop() ?? "";
  if (FAIL_RE.test(tail)) return "fail";
  if (DONE_RE.test(tail)) return "done";
  return "other";
}

/**
 * 从节点的工具清单里挑一个「查状态」的工具，作为轮询兜底。
 * 判据：名字像查询、且有一个必填参数像句柄键。
 * @param {Array<{name: string, inputSchema?: object}>} tools
 * @param {string} handleKey 句柄在返回里的键名（如 taskId）
 * @returns {{name: string, arg: string}|null}
 */
export function pickStatusProbe(tools, handleKey) {
  const wanted = String(handleKey ?? "id").toLowerCase();
  const candidates = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool?.name || !/(get|status|query|list|show|fetch)/i.test(tool.name)) continue;
    const props = tool?.inputSchema?.properties ?? {};
    const required = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
    for (const key of required) {
      const lower = key.toLowerCase();
      if (lower === wanted || HANDLE_KEY_RE.test(lower) || lower.includes("id")) {
        candidates.push({ name: tool.name, arg: key, score: lower === wanted ? 2 : 1 });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

/**
 * 一次「等待」的完整生命周期。
 *
 * 与真实时间的耦合被收进 `now` / `setTimeout`，方便单测用假时钟驱动。
 */
export class TaskWaiter {
  /**
   * @param {object} opts
   * @param {string} opts.handle 句柄（taskId）
   * @param {string} opts.handleKey 句柄的键名（task.id 之类），用于选轮询参数
   * @param {number} opts.timeoutMs 等待窗口
   * @param {number} [opts.pollMs] 轮询间隔
   * @param {(handle: string) => Promise<object>} [opts.poll] 轮询函数，返回最新状态
   * @param {(verdict: "done"|"fail") => void} [opts.onSettled] 结算回调（先到先得）
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    this.handle = opts.handle;
    this.handleKey = opts.handleKey ?? "id";
    this.timeoutMs = opts.timeoutMs;
    this.pollMs = opts.pollMs ?? 2000;
    this.poll = opts.poll ?? null;
    this.onSettled = opts.onSettled ?? (() => {});
    this.now = opts.now ?? (() => Date.now());

    this.settled = null;
    this.startedAt = this.now();
    this.polls = 0;
    /** 观测到的、含本次句柄的信号路径 —— 绑定学习的原料 */
    this.observed = new Map();
  }

  /** 喂一条信号；返回是否因此结算。 */
  acceptSignal(signalPath, payload, binding) {
    if (this.settled) return false;
    if (!matchesHandle(payload, this.handle)) return false;
    const verdict = classifySignal(signalPath, binding);
    if (verdict === "other") {
      // 含句柄但语义不明：仍然是一条强证据，用来学「哪条信号和这个任务有关」
      this.observed.set(signalPath, (this.observed.get(signalPath) ?? 0) + 1);
      return false;
    }
    this.settle(verdict, "signal", signalPath);
    return true;
  }

  /** 轮询一次；状态里出现句柄且该工具自身报完成 → 结算。 */
  async pollOnce() {
    if (this.settled || !this.poll) return false;
    this.polls += 1;
    let state;
    try {
      state = await this.poll(this.handle);
    } catch {
      return false;
    }
    const verdict = classifySignal(`${this.handleKey}.completed`, null);
    // 轮询结果里通常带 status 字段：completed / failed
    const status = String(state?.structuredContent?.status ?? state?.structuredContent?.task?.status ?? "");
    if (FAIL_RE.test(status)) {
      this.settle("fail", "poll");
      return true;
    }
    if (DONE_RE.test(status)) {
      this.settle("done", "poll", null, state);
      return true;
    }
    void verdict;
    return false;
  }

  settle(verdict, via, signalPath = null, value = null) {
    if (this.settled) return;
    this.settled = { verdict, via, signalPath, value, at: this.now() };
    this.onSettled(verdict);
  }

  get expired() {
    return !this.settled && this.now() - this.startedAt >= this.timeoutMs;
  }

  get elapsedMs() {
    return this.now() - this.startedAt;
  }
}
