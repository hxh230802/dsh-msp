/** 通知器自测：挑节点、节流、失败不抛、内容截断。 */
import { strict as assert } from "node:assert";

import { createNotifier, extractText, resolveIconPath } from "../lib/notify.js";

function fakePeer(nodeId, { connected = true, tools = [], fail = null, record, signals, signalOk = true } = {}) {
  return {
    nodeId,
    connected,
    toolMeta: new Map(tools.map((t) => [`msp_${nodeId}_${t}`, { mspName: t }])),
    peer: {
      publish: (path, payload) => {
        if (!signalOk) return false;
        if (signals) signals.push({ path, payload });
        return true;
      },
      callTool: async (tool, args) => {
        if (fail) throw fail;
        if (record) record.push({ nodeId, tool, args });
        return { content: [], structuredContent: { ok: true } };
      },
    },
  };
}

// 1. 优先用配置里指定的节点
{
  const hits = [];
  const peers = [
    fakePeer("other", { tools: ["notify"], record: hits }),
    fakePeer("notchpeninsula", { tools: ["notify", "media_control"], record: hits }),
  ];
  const n = createNotifier({ getPeers: () => peers, config: { notifyNode: "notchpeninsula", minIntervalMs: 0 } });
  assert.equal((await n.fire("info", "标题", "正文")).sent, true);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].nodeId, "notchpeninsula");
  assert.equal(hits[0].tool, "notify");
  assert.equal(hits[0].args.kind, "info");
  assert.equal(hits[0].args.title, "标题");
  assert.equal(hits[0].args.body, "正文");
}

// 2. 指定节点没连上 → 退回到任意有 notify 的已连节点
{
  const hits = [];
  const peers = [
    fakePeer("notchpeninsula", { connected: false, tools: ["notify"] }),
    fakePeer("other", { tools: ["notify"], record: hits }),
  ];
  const n = createNotifier({ getPeers: () => peers, config: { minIntervalMs: 0 } });
  assert.equal((await n.fire("info", "t", "b")).sent, true);
  assert.equal(hits[0].nodeId, "other");
}

// 3. 没有节点有 notify 能力 → 安静返回 false
{
  const peers = [fakePeer("a", { tools: ["ping"] })];
  const n = createNotifier({ getPeers: () => peers, config: { minIntervalMs: 0 } });
  assert.equal((await n.fire("info", "t", "b")).sent, false);
}

// 4. 节流：同一标题在窗口内只发一次
{
  const hits = [];
  const peers = [fakePeer("n", { tools: ["notify"], record: hits })];
  const n = createNotifier({ getPeers: () => peers, config: { minIntervalMs: 10_000 } });
  assert.ok(await n.fire("info", "同一标题", "b"));
  assert.equal((await n.fire("info", "同一标题", "b")).sent, false);
  assert.equal(hits.length, 1);
}

// 5. 底层抛错 → 返回 false 且交给 onError，绝不向上抛
{
  const errors = [];
  const peers = [fakePeer("n", { tools: ["notify"], fail: new Error("boom") })];
  const n = createNotifier({ getPeers: () => peers, config: { minIntervalMs: 0 }, onError: (e) => errors.push(e.message) });
  assert.equal((await n.fire("info", "t", "b")).sent, false);
  assert.deepEqual(errors, ["boom"]);
}

// 6. 正文字数截断 + 空白折叠
{
  const hits = [];
  const peers = [fakePeer("n", { tools: ["notify"], record: hits })];
  const n = createNotifier({ getPeers: () => peers, config: { minIntervalMs: 0, maxBodyChars: 10 } });
  await n.fire("info", "t", "一二三四五\n\n 六七八九十甲乙丙");
  assert.equal(hits[0].args.body.length, 10);
  assert.ok(hits[0].args.body.endsWith("…"));
}

// 7. payload 提取：各种形状都要能挖出一句话
{
  assert.equal(extractText({ question: "要删吗？" }), "要删吗？");
  assert.equal(extractText({ args: { questions: [{ question: "选哪个" }] } }), "选哪个");
  assert.equal(extractText({ tool: "rm", args: { path: "/x" } }), "rm");
  assert.equal(extractText(null), "");
}

// 8. 图标：配置了 iconPath 就随 content 发 image 块，role 必须是 icon
{
  const hits = [];
  const peers = [fakePeer("n", { tools: ["notify"], record: hits })];
  const n = createNotifier({
    getPeers: () => peers,
    config: { minIntervalMs: 0, iconPath: "assets/notify-icon-64.png" },
  });
  await n.fire("info", "带图标", "正文");
  const content = hits[0].args.content;
  assert.ok(Array.isArray(content) && content.length === 1, "应带 1 个 content 块");
  assert.equal(content[0].type, "image");
  assert.equal(content[0].mimeType, "image/png");
  assert.equal(content[0].annotations.role, "icon");
  assert.ok(content[0].data.length > 1000, "base64 应有内容");
}

// 9. 图标文件不存在 → 不带 content 也要能发出去
{
  const hits = [];
  const peers = [fakePeer("n", { tools: ["notify"], record: hits })];
  const n = createNotifier({ getPeers: () => peers, config: { minIntervalMs: 0, iconPath: "不存在.png" } });
  assert.equal((await n.fire("info", "无图标", "正文")).sent, true);
  assert.equal(hits[0].args.content, undefined);
}

// 10. 公告 + 投递：两条路都走
{
  const hits = [];
  const signals = [];
  const peers = [fakePeer("n", { tools: ["notify"], record: hits, signals })];
  const n = createNotifier({ getPeers: () => peers, config: { minIntervalMs: 0 } });
  const r = await n.fire("warning", "需要确认", "rm -rf 等待批准");
  assert.equal(r.sent, true);
  assert.equal(signals.length, 1, "应发一条信号");
  assert.equal(signals[0].path, "dsh.attention.requested");
  assert.equal(signals[0].payload.title, "需要确认");
  assert.equal(signals[0].payload.kind, "warning");
  assert.equal(hits.length, 1, "同时也应调一次工具");
}

// 11. 只要公告、不投递
{
  const hits = [];
  const signals = [];
  const peers = [fakePeer("n", { tools: ["notify"], record: hits, signals })];
  const n = createNotifier({ getPeers: () => peers, config: { minIntervalMs: 0, useTool: false } });
  const r = await n.fire("info", "只公告", "正文");
  assert.equal(r.sent, true);
  assert.equal(r.reason, "signal-only");
  assert.equal(signals.length, 1);
  assert.equal(hits.length, 0, "不应调工具");
}

// 12. 信号发不出去但工具可用 → 仍投递成功
{
  const hits = [];
  const peers = [fakePeer("n", { tools: ["notify"], record: hits, signalOk: false })];
  const n = createNotifier({ getPeers: () => peers, config: { minIntervalMs: 0 } });
  assert.equal((await n.fire("info", "信号失败", "正文")).sent, true);
  assert.equal(hits.length, 1);
}

// 13. 图标路径归一化：Windows 上前导斜杠会读不到文件
{
  assert.equal(resolveIconPath(null), null);
  assert.equal(resolveIconPath(""), null);
  assert.ok(resolveIconPath("F:/x/a.png").includes("a.png"));
  assert.ok(resolveIconPath("/F:/x/a.png").startsWith("F:"), "前导斜杠必须去掉");
  assert.ok(resolveIconPath("file:///F:/x/a.png").startsWith("F:"));
}

console.log("通知器 OK：挑节点 / 回退 / 无能力 / 节流 / 异常吞掉 / 截断 / payload 提取 / 图标块 / 图标缺失 / 公告+投递 / 只公告 / 信号失败仍投递");
