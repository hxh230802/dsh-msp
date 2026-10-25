/** client bundle 自测：mock window.__ModuleLoader__，断言导出与两处注册。 */
import { strict as assert } from "node:assert";

let loadedId = null;
let mod = null;

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loadedId = id;
      mod = factory((name) => {
        if (name === "react") return fakeReact;
        throw new Error(`unexpected require: ${name}`);
      });
    },
  },
};

await import("../lib/client.js");

assert.equal(loadedId, "dsh-msp", "bundle id 必须是包名");
assert.equal(typeof mod.apply, "function", "必须导出 apply");
assert.ok(Array.isArray(mod.inject), "必须导出 inject 数组");

const registered = [];
const ctx = {
  slots: {
    inject(seat, cb) { cb(); return () => {}; },
    register(def, component) { registered.push({ seat: def.name, id: def.id, key: def.key, component }); return () => {}; },
  },
};
const dispose = mod.apply(ctx);
assert.equal(registered.length, 2, `应注册 2 个座位，实际 ${registered.length}`);

const sidebar = registered.find((r) => r.seat === "sidebar.panellist");
const main = registered.find((r) => r.seat === "main");
assert.ok(sidebar, "缺 sidebar.panellist 注册");
assert.ok(main, "缺 main 注册");
assert.equal(sidebar.id, "dsh-msp");
assert.equal(main.key, "dsh-msp", "main 的 key 必须与侧栏 id 相同，否则点了不换页");
assert.equal(typeof sidebar.component, "function");
assert.equal(typeof main.component, "function");
assert.equal(typeof dispose, "function");

// 无 slots 时必须优雅退出
const quiet = mod.apply({});
assert.equal(typeof quiet, "function");

console.log("client bundle OK：id/mod(apply,inject)/2 个座位/无 slots 时优雅退出");
