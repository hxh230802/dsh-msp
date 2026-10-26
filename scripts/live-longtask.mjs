/**
 * 真实端到端：对着运行中的 gd3 下载一个小文件，验证
 *   add_task 返回句柄 → 收信号 → call_wait 结算 → 清理任务
 *
 *     node scripts/live-longtask.mjs
 *
 * 会往 folder 里落一个文件，结束时连任务带文件一起删掉。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MspPeer } from "../lib/msp.js";
import { createLongTasks } from "../lib/longtask.js";

const nodesDir = `${process.env.USERPROFILE}/.msp/nodes`;
const folder = process.env.MSP_TEST_FOLDER ?? path.join(os.tmpdir(), "msp-live-test");
fs.mkdirSync(folder, { recursive: true });

const peer = new MspPeer({
  nodesDir,
  gatewayId: "gd3",
  retryMs: 60_000,
  callTimeoutMs: 15_000,
});
const signals = [];
const tasks = createLongTasks({ prefix: "msp_", config: { waitMs: 20_000, pollMs: 1_500 } });
peer.onSignal = (sig) => {
  signals.push(sig);
  const keys = sig.payload && typeof sig.payload === "object" ? Object.keys(sig.payload) : [];
  console.log(`  [signal] ${sig.path}  keys=${keys.join(",")}`);
  tasks.feedSignal(sig);
};
peer.start();

const t0 = Date.now();
while (!peer.connected && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
if (!peer.connected) {
  console.error("连不上 gd3");
  process.exit(1);
}
console.log("已连上 gd3，工具:", peer.tools.map((t) => t.name).join(", "));
console.log("宣告的信号:", (peer.manifest?.signals ?? []).map((s) => s.path).join(", "));

let taskId = null;
try {
  const value = await tasks.callAndWait({
    node: "gd3",
    tool: "add_task",
    args: { urls: ["https://example.com/"], folder, name: "msp-live-test.html" },
    waitMs: 20_000,
    pollMs: 1_500,
  }, {
    getPeer: () => ({ peer, tools: peer.tools }),
    onPending: (r) => console.log("  [后台完成]", JSON.stringify(r)),
  });
  taskId = value.taskId ?? null;
  console.log("\n=== call_wait 结果 ===");
  console.log("  status:", value.status, "| via:", value.via ?? "-", "| taskId:", value.taskId ?? "-");
  console.log("  result:", JSON.stringify(value.result)?.slice(0, 300));
} catch (err) {
  console.error("调用失败:", err.message);
} finally {
  // 清理：删任务（未完成的文件总是删除）+ 删目录
  const status = await peer.callTool("list_tasks", {}).catch(() => null);
  const open = status?.structuredContent?.tasks ?? [];
  if (open.length) {
    await peer.callTool("remove_task", { taskIds: open.map((t) => t.id), deleteFiles: true }).catch(() => {});
  }
  void taskId;
  fs.rmSync(folder, { recursive: true, force: true });
  console.log(`\n收到信号 ${signals.length} 条：${signals.map((s) => s.path).join(", ") || "（一条都没有）"}`);
  peer.stop();
  process.exit(0);
}
