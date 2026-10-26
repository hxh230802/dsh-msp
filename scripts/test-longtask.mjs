/**
 * 长任务编排自测：用假 peer 驱动，不需要真实 MSP 网络、也不需要等真实时间。
 *
 * 覆盖三条路径：
 *   1. 信号先到 → 立即返回 completed（走 via:"signal"）
 *   2. 信号不来 → 轮询兜底发现完成（via:"poll"）
 *   3. 两者都没有 → 超时返回 pending 句柄，之后后台完成记一条记录
 */
import { strict as assert } from "node:assert";

import { createLongTasks } from "../lib/longtask.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个会说"我已经下载完成"的假节点。 */
function fakePeer({ statusAfter = 0, delayMs = 0 } = {}) {
  let calls = 0;
  return {
    peer: {
      callTool: async (tool, args) => {
        if (tool === "add_task") return { content: [], structuredContent: { taskId: "T1", status: "running" } };
        if (tool === "get_task") {
          calls += 1;
          await sleep(delayMs);
          const done = calls > statusAfter;
          return {
            content: [],
            structuredContent: { task: { id: args.taskId, status: done ? "completed" : "running" }, files: done ? ["a.bin"] : [] },
          };
        }
        return { content: [], structuredContent: {} };
      },
      publish: () => true,
    },
    tools: [
      { name: "add_task", inputSchema: { type: "object", properties: { urls: { type: "array" } } } },
      {
        name: "get_task",
        inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      },
    ],
  };
}

// ---- 1. 信号先到 ----
{
  const entry = fakePeer({ statusAfter: 999 }); // 轮询永远看不到完成
  const tasks = createLongTasks({ prefix: "msp_", config: { waitMs: 3000, pollMs: 100 } });
  const deps = { getPeer: () => entry };

  // 启动后 150ms 发一条 task.completed 信号（payload 里带本次句柄 T1）
  setTimeout(() => {
    tasks.feedSignal({ source: "gd3", path: "task.completed", payload: { task: { id: "T1" }, files: ["a.bin"] } });
  }, 150);

  const value = await tasks.callAndWait({ node: "gd3", tool: "add_task", args: { urls: ["x"] }, waitMs: 3000, pollMs: 100 }, deps);
  assert.equal(value.status, "completed");
  assert.equal(value.via, "signal");
  assert.equal(value.taskId, "T1");
}

// ---- 2. 信号不来，轮询兜底 ----
{
  const entry = fakePeer({ statusAfter: 1 }); // 第二次 get_task 报 completed
  const tasks = createLongTasks({ prefix: "msp_", config: { waitMs: 3000, pollMs: 100 } });
  const value = await tasks.callAndWait(
    { node: "gd3", tool: "add_task", args: {}, waitMs: 3000, pollMs: 100 },
    { getPeer: () => entry },
  );
  assert.equal(value.status, "completed");
  assert.equal(value.via, "poll");
}

// ---- 3. 超时 → pending，后台完成记一条 ----
{
  const entry = fakePeer({ statusAfter: 2 });
  const completed = [];
  const tasks = createLongTasks({
    prefix: "msp_",
    config: { waitMs: 300, pollMs: 100, backgroundPollMs: 80, backgroundTtlMs: 5000 },
  });
  const value = await tasks.callAndWait(
    { node: "gd3", tool: "add_task", args: {}, waitMs: 300, pollMs: 100 },
    { getPeer: () => entry, onPending: (r) => completed.push(r) },
  );
  assert.equal(value.status, "pending", `应返回 pending，实际 ${value.status}`);
  assert.equal(value.taskId, "T1");
  assert.equal(tasks.watching.size, 1, "应有一个后台观察者");

  // 等后台发现完成
  const deadline = Date.now() + 3000;
  while (completed.length === 0 && Date.now() < deadline) await sleep(50);
  assert.equal(completed.length, 1, "后台应记一条完成记录");
  assert.equal(completed[0].taskId, "T1");
  assert.equal(completed[0].acknowledged, false, "新记录应标记未告知");
  assert.equal(tasks.watching.size, 0, "完成后观察者应清掉");
}

// ---- 4. 工具没返回句柄 → 当作已经完成，不等待 ----
{
  const entry = {
    peer: { callTool: async () => ({ content: [], structuredContent: { ok: true } }), publish: () => true },
    tools: [],
  };
  const tasks = createLongTasks({});
  const value = await tasks.callAndWait({ node: "x", tool: "ping", args: {} }, { getPeer: () => entry });
  assert.equal(value.status, "completed");
  assert.equal(value.waited, false);
}

// ---- 5. 节点不存在 ----
{
  const tasks = createLongTasks({});
  await assert.rejects(
    () => tasks.callAndWait({ node: "nope", tool: "ping" }, { getPeer: () => null }),
    /未连接节点/,
  );
}

console.log("长任务 OK：信号先到 / 轮询兜底 / 超时转后台并记录 / 无句柄直返 / 节点不存在");
