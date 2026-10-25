/** 验证 notify 收不收 content 里的 icon 块：发一条带鲸鱼娘图标的通知。 */
import { readFileSync } from "node:fs";

import { MspPeer } from "../lib/msp.js";

const iconPath = new URL("../assets/notify-icon-64.png", import.meta.url);
const data = readFileSync(iconPath).toString("base64");

const peer = new MspPeer({
  nodesDir: `${process.env.USERPROFILE}/.msp/nodes`,
  gatewayId: "notchpeninsula",
  retryMs: 60_000,
});
peer.start();
const t0 = Date.now();
while (!peer.connected && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
if (!peer.connected) {
  console.error("连不上 notchpeninsula");
  process.exit(1);
}

const result = await peer.callTool("notify", {
  kind: "info",
  title: "图标测试",
  body: "如果图标是鲸鱼娘，说明 icon 块这条路通了。",
  content: [{ type: "image", data, mimeType: "image/png", annotations: { role: "icon" } }],
});
peer.stop();

if (result.error) {
  console.error("失败:", result.error);
  process.exit(1);
}
console.log(JSON.stringify(result.structuredContent ?? result.content, null, 2));
process.exit(0);
