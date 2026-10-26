/**
 * 真下一个大文件，演示「窗口内没完成 → 返回 pending → 后台观察直到完成」。
 *
 *     node scripts/live-download.mjs [url] [waitMs]
 *
 * 文件落在 gd3 配置的下载目录（不指定 folder）。用 gd3 的默认冲突策略。
 */

import { MspPeer } from "../lib/msp.js";
import { createLongTasks } from "../lib/longtask.js";

const url = process.argv[2] ?? "https://proof.ovh.net/files/100Mb.dat";
const waitMs = Number(process.argv[3] ?? 8000);

const peer = new MspPeer({
  nodesDir: `${process.env.USERPROFILE}/.msp/nodes`,
  gatewayId: "gd3",
  retryMs: 60_000,
  callTimeoutMs: 20_000,
});
const tasks = createLongTasks({ prefix: "msp_", config: { waitMs, pollMs: 1500 } });
const signals = [];
peer.onSignal = (sig) => {
  signals.push(sig.path);
  console.log(`  [signal] ${sig.path}`);
  tasks.feedSignal(sig);
};
peer.start();

while (!peer.connected) await new Promise((r) => setTimeout(r, 50));
console.log(`已连上 gd3；开始下载 ${url}（等待窗口 ${waitMs} ms）`);

const completions = [];
const value = await tasks.callAndWait(
  { node: "gd3", tool: "add_task", args: { urls: [url] }, waitMs, pollMs: 1500 },
  { getPeer: () => ({ peer, tools: peer.tools }), onPending: (r) => completions.push(r) },
);

console.log("\n=== call_wait 返回 ===");
console.log(`  status=${value.status} via=${value.via ?? "-"} taskId=${value.taskId ?? "-"}`);

if (value.status === "pending") {
  const taskId = value.taskId;
  console.log("窗口内没下完 → 已转后台，开始轮询观察进度：");
  const startedAt = Date.now();
  let lastLine = "";
  while (Date.now() - startedAt < 150_000) {
    const st = await peer.callTool("get_task", { taskId });
    const task = st?.structuredContent ?? {};
    const line = `${task.status ?? "?"} ${task.progress ?? "?"}%`;
    // 每 6 秒至少打一行，进度不变也能看出"卡住了"而不是"没在跑"
    if (line !== lastLine || Math.round((Date.now() - startedAt) / 1000) % 6 === 0) {
      console.log(`  ${((Date.now() - startedAt) / 1000).toFixed(0)}s  ${line}  fileSize=${task.fileSize ?? 0}  files=${(task.files ?? []).length}`);
      lastLine = line;
    }
    if (task.status === "completed" || task.status === "failed") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const final = await peer.callTool("get_task", { taskId });
  console.log("\n=== 最终状态 ===");
  console.log(JSON.stringify(final?.structuredContent?.task ?? final?.structuredContent, null, 2)?.slice(0, 600));
}

console.log(`\n收到信号: ${signals.join(", ") || "（无）"}`);
console.log(`后台完成记录: ${JSON.stringify(completions)}`);
peer.stop();
process.exit(0);
