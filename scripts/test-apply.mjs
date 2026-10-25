/**
 * 插件入口 apply() 的冒烟测试——**这层之前完全没有覆盖**，
 * 结果漏了一个 import，apply 一进来就抛 "createTurnTracker is not defined"，
 * 整个插件加载失败（面板和工具全没），自测却全绿。
 *
 * 用空发现目录，避免连真实 MSP 网络。
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { apply } from "../lib/index.js";

const nodesDir = fs.mkdtempSync(path.join(os.tmpdir(), "msp-apply-"));

const tools = [];
const routes = [];
const effects = [];
const events = [];

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register(def) { tools.push(def); return () => {}; } },
  webServer: { register(route) { routes.push(route); return () => {}; } },
  effect(fn) { effects.push(fn()); },
  on(name, handler, options) { events.push({ name, handler, options }); },
};

const root = {
  inject(deps, cb) { cb(ctx); },
  on(name, handler, options) { events.push({ name, handler, options }); },
};

// 1. apply 不能抛
assert.doesNotThrow(() => apply(root, { nodesDir, verbose: false }));

// 2. 元工具注册了
const statusTool = tools.find((t) => t.name === "msp_status");
assert.ok(statusTool, "msp_status 必须注册");
assert.equal(typeof statusTool.execute, "function");
assert.equal(statusTool.parameters.type, "object");

// 3. 三条路由都注册了
const paths = routes.map((r) => r.path).sort();
assert.deepEqual(paths, ["/msp/node", "/msp/notify", "/msp/state"], `路由不对: ${paths}`);

// 4. 事件钩子订阅了，且都带 global: true（不带就收不到别的作用域的事件）
const byName = new Map(events.map((e) => [e.name, e]));
assert.ok(byName.has("session/event"), "必须订阅 session/event");
assert.equal(byName.get("session/event").options?.global, true, "session/event 必须 global:true");
assert.ok(byName.has("approval/asked"), "必须订阅 approval/asked");
assert.equal(byName.get("approval/asked").options?.global, true, "approval/asked 必须 global:true");
assert.ok(byName.has("tools/pre-execute"), "必须订阅 tools/pre-execute");

// 5. 状态路由真的能返回（证明闭包里的 api 接上了）
{
  let status = 0;
  let body = "";
  const res = { writeHead(s) { status = s; }, end(b) { body = b; } };
  routes.find((r) => r.path === "/msp/state").handler({ method: "GET", headers: {} }, res);
  assert.equal(status, 200);
  const parsed = JSON.parse(body);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.notify && typeof parsed.notify.approval === "boolean", "state 必须带 notify 开关");
  assert.ok(parsed.hooks && typeof parsed.hooks.turnEnd === "number", "state 必须带钩子计数");
  assert.deepEqual(parsed.peers, [], "空目录不应有对端");
  // 内置鲸鱼娘图标必须真的读到了（Windows 上前导斜杠那个坑会在这里现形）
  assert.ok(parsed.notifyIcon, "state 必须带图标状态");
  assert.equal(parsed.notifyIcon.ok, true, `内置图标应可用: ${JSON.stringify(parsed.notifyIcon)}`);
  assert.equal(parsed.notifyIcon.source, "embedded", "默认应用内联 base64，不读文件");
  assert.ok(parsed.notifyIcon.chars > 1000, "图标 base64 应有内容");
}

// 6. session/event 钩子能吃事件且不抛（空目录下没有已连对端，通知会安静跳过）
{
  const handler = byName.get("session/event").handler;
  assert.doesNotThrow(() => handler({ id: "s1" }, { type: "turn/start", seq: 1 }));
  assert.doesNotThrow(() => handler({ id: "s1" }, { type: "turn/end", seq: 2, reason: "ok" }));
}

// 7. 清理不能抛
for (const dispose of effects) assert.doesNotThrow(() => dispose());

fs.rmSync(nodesDir, { recursive: true, force: true });
console.log("插件入口 OK：apply 不抛 / 元工具 / 3 条路由 / 事件订阅带 global / state 可读 / 内联图标可用 / 清理");
