/** 轮次跟踪：事件分派、seq 去重、多会话隔离、时长缺失。 */
import { strict as assert } from "node:assert";

import { createTurnTracker } from "../lib/turns.js";

let clock = 1000;
const ends = [];
const tracker = createTurnTracker({ onEnd: (e) => ends.push(e), now: () => clock });

const s1 = { id: "s1" };
const s2 = { id: "s2" };

// 1. 正常一轮：start → +25s → end
assert.equal(tracker.accept(s1, { type: "turn/start", seq: 1 }), "start");
clock += 25_000;
assert.equal(tracker.accept(s1, { type: "turn/end", seq: 2, reason: "ok" }), "end");
assert.equal(ends.length, 1);
assert.equal(ends[0].ms, 25_000);
assert.equal(ends[0].reason, "ok");

// 2. 只有 end 没有 start → 时长未知（null），不能伪装成 0
assert.equal(tracker.accept(s2, { type: "turn/end", seq: 1 }), "end");
assert.equal(ends[1].ms, null);

// 3. seq 去重：重复投递不触发第二次
assert.equal(tracker.accept(s2, { type: "turn/end", seq: 1 }), "duplicate");
assert.equal(ends.length, 2);

// 4. 非轮次事件忽略
assert.equal(tracker.accept(s1, { type: "message", seq: 3 }), "ignored");

// 5. 多会话并发：各自的 start 不串
clock = 5000;
tracker.accept(s1, { type: "turn/start", seq: 10 });
clock = 7000;
tracker.accept(s2, { type: "turn/start", seq: 20 });
clock = 9000;
tracker.accept(s1, { type: "turn/end", seq: 11 });
tracker.accept(s2, { type: "turn/end", seq: 21 });
const lastTwo = ends.slice(-2);
assert.equal(lastTwo[0].ms, 4000, "s1 应从 5000 算起");
assert.equal(lastTwo[1].ms, 2000, "s2 应从 7000 算起");

// 6. 会话/事件形状不对时安静忽略
assert.equal(tracker.accept(null, { type: "turn/start" }), "ignored");
assert.equal(tracker.accept({}, { type: "turn/start" }), "ignored");
assert.equal(tracker.accept(s1, null), "ignored");

console.log("轮次跟踪 OK：时长 / 缺失 / 去重 / 忽略 / 多会话隔离");
