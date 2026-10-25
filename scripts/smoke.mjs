/**
 * 冒烟测试：用假 ctx 驱动插件，验证「连上网关 → 注册工具 → 调用往返」。
 *
 *     node scripts/smoke.mjs
 *
 * 不碰 DSH 本体：ctx.tools.register / ctx.effect / root.inject 都按 dsh-ops 的
 * 用法做最小 mock，所以能在装插件之前就把链路跑通。
 */

import { apply } from "../lib/index.js";

const registered = new Map();
const effects = [];

const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  },
  effect(fn) {
    effects.push(fn());
  },
  logger: {
    info: (m) => console.log("[info]", m),
    warn: (m) => console.log("[warn]", m),
    error: (m) => console.log("[error]", m),
  },
};

const root = {
  inject(deps, cb) {
    console.log("[inject]", deps.join(","));
    cb(ctx);
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

apply(root, { gateway: "gateway", verbose: true });
await sleep(2500);

console.log("\n=== 已注册的 DSH 工具 ===");
for (const [toolName, def] of registered) {
  console.log(`  ${toolName}  —  ${def.description.slice(0, 60)}`);
}

const status = registered.get("msp_status");
if (!status) {
  console.error("FAIL: msp_status 未注册");
  process.exit(1);
}

const value = await status.execute({}, {});
const s = value.structuredContent;
console.log("\n=== msp_status ===");
console.log("  connected:", s.connected);
console.log("  gateway  :", s.gateway);
console.log("  tools    :", s.tools);
console.log("  discovered:", s.discovered.map((d) => `${d.nodeId}(${d.ageSeconds}s)`).join(", "));

// 有设备工具就做一次「参数非法」的往返：验证请求/响应与错误路径，
// 又不会真的动硬件（合法参数才会转风扇/舵机）。
// 优先挑 led_control：它接受 action 枚举，能用非法值验证错误路径而不动硬件
const names = [...registered.keys()].filter((n) => n !== "msp_status");
const deviceTool = names.find((n) => n.endsWith("_led_control")) ?? names[0];
if (deviceTool) {
  const def = registered.get(deviceTool);
  console.log(`\n=== 调 ${deviceTool}（故意用非法参数，验证往返与错误路径）===`);
  try {
    const args = deviceTool.endsWith("_led_control")
      ? { action: "NOT_A_VALID_ACTION" }   // 设备会拒；合法值才真的动灯
      : {};
    const out = await def.execute(args, {});
    console.log("  返回:", JSON.stringify(out.structuredContent ?? out.content));
  } catch (err) {
    console.log("  按预期抛错（说明往返成功、错误能传回来）:", err.message);
  }
} else {
  console.log("\n(网关当前没有挂载任何设备工具，只验证了 msp_status)");
}

for (const dispose of effects) {
  try {
    dispose();
  } catch {
    /* 已清理 */
  }
}
console.log("\n冒烟结束");
process.exit(0);
