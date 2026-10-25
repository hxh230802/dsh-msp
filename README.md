# dsh-msp

把**本机 MSP 网络上每个节点**的工具暴露成 DeepSeek Harness 工具，agent 直接调用：

```
agent ──(DSH tool)──> dsh-msp ──(MSP/TCP, 每节点一条连接)──> gateway / notchpeninsula / …
                                                                  └─(MCP/WS)─> ESP32
```

## 装

```bash
dsh plugin --profile <profile> add /path/to/dsh-msp --ignore-workspace-root-check
dsh --profile <profile> --dump-config | grep -A8 'id: dsh-msp'   # 确认配置树里有这行
```

**host 侧插件，改完要重启 GUI 才生效**（刷新页面不算）。卸载：
`dsh plugin --profile <profile> remove dsh-msp`。

## 配

`cordis.patch.yml`（装成 profile 依赖后自动并进配置树）：

```yaml
- insert:
    - id: dsh-msp
      name: dsh-msp
      config:
        nodesDir: ~/.msp/nodes
        includeNodes: []        # 非空 = 只连这些节点（白名单）
        excludeNodes: []        # 黑名单，例如 [test.node1, demo_signals]
        toolPrefix: msp_
        discoveryMs: 3000       # 发现目录扫描间隔
        callTimeoutMs: 30000
        retryMs: 3000           # 单节点断开后的重拨间隔
        staleAfterMs: 30000     # 租约：超过这么久没续租的声明视为已死
        maxPeers: 16
        verbose: false
```

## 行为

- **每个节点一条连接**：按发现目录里的租约跟踪所有新鲜节点（> `staleAfterMs` 未续租
  的声明直接忽略——这就是 MSP 的"崩溃自动消失"）。
- **工具名 = `msp_<节点>_<工具>`**：节点 id 归一化成 `[a-z0-9_]`；若工具名本身已带
  该前缀则不重复拼（`notchpeninsula_hellomsp_echo` → `msp_notchpeninsula_hellomsp_echo`）。
- **断开 ≠ 摘除**：socket 断了工具仍在（否则模型手里的工具名会跳变），调用返回
  「未连接」；只有**租约过期**（节点真的没了）才摘掉那组工具。
- **清单跟随**：节点推 `MANIFEST_UPDATE`（设备上线/掉线、工具增删）时按名字 diff，
  不重启会话。
- **错误即值 → 抛错**：MSP 的 `ToolResult(error=...)` 在 DSH 侧表现为 `throw`。
- 零依赖：MSP 客户端在 `lib/msp.js` 里自带，不引 npm 包。

## 自带工具

| 工具 | 作用 |
|---|---|
| `msp_status` | 每个节点的连接状态、端点、已暴露的工具；发现目录里的全部节点（含租约年龄） |

## 自测（不需要 DSH）

```bash
node scripts/smoke.mjs        # 假 ctx 驱动插件，对着真实 MSP 网络跑「发现→连接→注册→调用」
node scripts/probe-peers.mjs  # 只探测：逐个连上新节点，打印它们的工具/信号/能力，不注册
```

## 已知边界

- 只做 `request-reply`（工具调用），**不订阅 MSP 广播**——MSP 的 `signal` 被忽略，
  所以 `notify.*`、`media.track.changed` 这类信号不会推进模型上下文。
- 工具 schema 变化但名字不变时不会重注册（避免打断会话）；节点重连才会拿到新 schema。
- 无鉴权：MSP 本机自组网的信任模型是"传输可达即信任"，跨机请自行加隔离。
