# dsh-msp

把 **MSP 网关**挂载的设备工具（ESP32 风扇/舵机/LED 之类）暴露成 DeepSeek Harness 工具，
让 agent 直接调用：

```
agent ──(DSH tool)──> dsh-msp ──(MSP/TCP)──> msp-gateway ──(MCP/WS)──> ESP32
```

## 装

```bash
dsh plugin --profile <profile> add /path/to/dsh-msp --ignore-workspace-root-check
dsh --profile <profile> --dump-config | grep -A6 'id: dsh-msp'   # 确认配置树里有这行
```

**host 侧插件，改完要重启 GUI 才生效**（不能靠刷新页面）。卸载：
`dsh plugin --profile <profile> remove dsh-msp`。

## 配

`cordis.patch.yml`（装成 profile 依赖后自动并进配置树）：

```yaml
- insert:
    - id: dsh-msp
      name: dsh-msp
      config:
        nodesDir: ~/.msp/nodes     # MSP 共享发现目录
        gateway: gateway           # 网关节点的 node_id
        toolPrefix: msp_           # DSH 里的工具名前缀
        exclude: []                # 不想暴露给模型的工具（原始名）
        callTimeoutMs: 30000
        retryMs: 3000              # 网关不在时的重试间隔
        verbose: false
```

## 行为

- **工具集合跟着网关清单走**：设备上线/掉线 → 网关推 `MANIFEST_UPDATE` → 本插件按名字
  diff，增删 DSH 工具，不用重启会话。
- **网关不在也能启动**：后台每 `retryMs` 重试，连上后自动补齐工具；`msp_status`
  永远可用（用来诊断"为什么没工具"）。
- **错误即值 → 抛错**：MSP 的 `ToolResult(error=...)` 在 DSH 侧表现为 `throw`，
  让模型读到原因而不是把空成功当答案。
- 零依赖：MSP 客户端在 `lib/msp.js` 里自带（~300 行），不引 npm 包。

## 自带工具

| 工具 | 作用 |
|---|---|
| `msp_status` | 连接状态、已暴露的工具、发现目录里的所有节点（含租约年龄） |

## 自测（不需要 DSH）

```bash
node scripts/smoke.mjs
```

用最小 mock 的 `ctx.tools.register` / `ctx.effect` / `root.inject` 驱动插件，
对着**真实运行的网关**验证：连上 → 注册工具 → 调用往返。

## 已知边界

- 只做 `request-reply`（工具调用），不订阅 MSP 广播——MSP 的 `signal` 目前被忽略。
- 工具 schema 变化但名字不变时不会重注册（避免打断会话）；重连才会拿到新 schema。
- 连接的是网关这一个节点；未连接其它 MSP 邻居（`msp_status` 只读目录里的声明）。
- 无鉴权：MSP 本机自组网的信任模型就是"传输可达即信任"，跨机请自行加隔离。
