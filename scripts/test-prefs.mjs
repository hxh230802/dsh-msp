/** 通知开关持久化：默认值、缺字段补全、损坏文件、落盘往返。 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaultPrefs, loadPrefs, savePrefs, prefsPath } from "../lib/prefs.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msp-prefs-"));
const file = path.join(dir, "notify.json");

// 1. 配置种子 → 默认值
assert.deepEqual(defaultPrefs({}), { approval: true, question: true, turnEnd: true });
assert.deepEqual(defaultPrefs({ notifyOnTurnEnd: false }), { approval: true, question: true, turnEnd: false });

// 2. 文件不存在 → 默认值
assert.deepEqual(loadPrefs(path.join(dir, "nope.json"), { approval: true, question: false, turnEnd: true }),
  { approval: true, question: false, turnEnd: true });

// 3. 落盘 + 回读
assert.equal(savePrefs(file, { approval: false, question: true, turnEnd: false }), true);
assert.deepEqual(loadPrefs(file, defaultPrefs({})), { approval: false, question: true, turnEnd: false });

// 4. 旧文件缺字段 → 用默认值补齐
fs.writeFileSync(file, JSON.stringify({ approval: false }), "utf-8");
assert.deepEqual(loadPrefs(file, defaultPrefs({})), { approval: false, question: true, turnEnd: true });

// 5. 损坏文件 → 默认值，不抛
fs.writeFileSync(file, "{ 坏掉的 json", "utf-8");
assert.deepEqual(loadPrefs(file, defaultPrefs({})), { approval: true, question: true, turnEnd: true });

// 6. 路径在 ~/.dsh/dsh-msp 下
assert.ok(prefsPath("/home/x").split(path.sep).join("/")
  .endsWith(".dsh/dsh-msp/notify.json"));

fs.rmSync(dir, { recursive: true, force: true });
console.log("开关持久化 OK：默认值 / 缺失 / 往返 / 补全 / 损坏 / 路径");
