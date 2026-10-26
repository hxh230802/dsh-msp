# dsh-msp

Expose the tools of **every node on your local [MSP](https://github.com/hxh230802/MSP) network** as
DeepSeek Harness tools, so the agent can call them directly:

```
agent ──(DSH tool)──> dsh-msp ──(MSP/TCP, one connection per node)──> gateway / notchpeninsula / …
                                                                        └─(MCP/WS)─> ESP32
```

English | [中文](README.zh.md)

## Install

```bash
# from GitHub (the repo ships lib/ ready to run — no build step)
dsh plugin --profile <profile> add github:hxh230802/dsh-msp --ignore-workspace-root-check

# pin an exact release (recommended for anyone but the author — tracking the
# branch means every commit is instantly "released")
dsh plugin --profile <profile> add github:hxh230802/dsh-msp#v0.1.1 --ignore-workspace-root-check

# from a local checkout (development; pnpm links, so edits are live)
dsh plugin --profile <profile> add /path/to/dsh-msp --ignore-workspace-root-check

# verify the row landed in the composed config tree
dsh --profile <profile> --dump-config | grep -A8 'id: dsh-msp'
```

This is a **host-side plugin: restart the GUI after changing it** (reloading the page is not enough).
Uninstall with `dsh plugin --profile <profile> remove dsh-msp`.

## Configure

`cordis.patch.yml` — merged into the config tree once the package is a profile dependency:

```yaml
- insert:
    - id: dsh-msp
      name: dsh-msp
      config:
        nodesDir: ~/.msp/nodes
        includeNodes: []        # non-empty => allowlist only
        excludeNodes: []        # e.g. [test.node1, demo_signals]
        toolPrefix: msp_
        discoveryMs: 3000       # discovery directory scan interval
        callTimeoutMs: 30000
        retryMs: 3000           # reconnect delay per node
        staleAfterMs: 30000     # lease: declarations older than this are dead
        maxPeers: 16
        verbose: false
```

## Behaviour

- **One connection per node.** Every fresh node in the discovery directory gets its own
  connection. Freshness comes from MSP leases: a declaration not renewed within
  `staleAfterMs` is ignored — that is MSP's "crashed processes disappear" property.
- **Tool name = `msp_<node>_<tool>`.** Node ids are normalised to `[a-z0-9_]`. If the tool
  name already carries that prefix it is not doubled
  (`notchpeninsula_hellomsp_echo` → `msp_notchpeninsula_hellomsp_echo`).
- **Disconnect ≠ removal.** A dropped socket keeps the tools (otherwise tool names would
  flicker under the model); calls return "not connected". Tools are only removed when the
  **lease expires** — i.e. the node is really gone.
- **Tools follow the manifest.** When a node pushes `MANIFEST_UPDATE` (device plugged in or
  removed, tools added or dropped) the plugin diffs by name and republishes — no session
  restart.
- **Error as value → throw.** MSP's `ToolResult(error=...)` surfaces as a thrown error, so
  the model reads the reason instead of treating an empty success as an answer.
- **Zero dependencies.** The MSP client is bundled in `lib/msp.js`; nothing is installed from npm.
- **Unique node id per process.** The plugin joins the network as `dsh-msp-<8hex>`, generated at
  startup. It cannot be a fixed `dsh-msp`: a peer keys its connection table **by node id**
  (`connections[peer_id] = conn`) and its handshake dedup picks a direction by comparing ids, so
  two processes reporting the same id look like one peer with two connections — the later one
  evicts the earlier and both end up flapping. Two DSH windows, two profiles, or a second DSH on
  the same machine would all collide. Set `nodeId` if you need a **stable** identity (for example
  when a peer allowlists you by id).

## UI (client half)

After a restart the left sidebar shows an **MSP** icon that opens a full page:

| Section | Content |
|---|---|
| **Node / tool graph** | Centre is this plugin; each outer circle is an MSP node. Solid line = connected, dashed = disconnected; circle size grows with tool count, the number inside is that count |
| **Permissions & tools** | One row per node: status dot, address, enable/disable button, and the tools it advertises (parameter names; hover for descriptions). Disabling drops the node and its tools immediately |
| **Notification switches** | Three independent toggles: approval waiting / question waiting / task finished (long tasks only) |
| **Recent calls** | Time / node / tool / duration or error, from the last 40 calls recorded host-side |
| **Discovery directory** | Every declaration file and its lease age (including expired ones nobody cleaned up) |

Data path: the host registers three routes, the page polls every 2 s.

```
GET  /msp/state   → { ok, peers[], calls[], discovered[], policy, notify, notifyIcon, hooks }
POST /msp/node    → { nodeId, enabled }   change permissions; reconnects/drops immediately
POST /msp/notify  → { key, enabled }      or { approval|question|turnEnd: boolean }  toggle notifications
```

The browser half is a hand-written CJS bundle (`lib/client.js`, wrapped in
`window.__ModuleLoader__.load`, `react` supplied by the host) — **no build toolchain needed**.
If the host does not expose the `slots` service, `apply` exits quietly: the panel is absent
but nothing else breaks.

## Notifications

Three switches, one per situation, toggled from the panel:

| Switch | Hooked event | Notes |
|---|---|---|
| Approval waiting | `approval/asked` | Fires when an approval is raised |
| Question waiting | `tools/pre-execute` with tool `ask_user_question` | Sends the question text |
| Task finished | `session/event` where `event.type === 'turn/end'` | Only if the turn ran ≥ `turnEndMinMs` (default 20 s) |

**Precedence:** the panel choice wins over the `notifyOn*` defaults in `cordis.patch.yml`.
The choice is persisted to `~/.dsh/dsh-msp/notify.json` and survives restarts — otherwise every
restart would silently re-enable what the user turned off. A missing or corrupt file falls back
to the defaults and never blocks startup.

Notifications go through MSP `notify`: the host calls the node directly, so **no model round
trip, no tokens, no turn consumed**.

### Why two channels: announce + deliver

In MSP a `signal` is an **announcement** ("X already happened") while a tool is a **command**
("please do X"). The peer's signal `notify.toast.raised` is described as *"a system notification
**arrived**"* — a past-tense observation. Publishing into it would claim a toast already exists,
and a receiver with no matching handler drops it silently (by design: errors are never returned
to unauthorised peers).

So the plugin splits the job:

| Channel | Mechanism | Semantics | Consumers |
|---|---|---|---|
| **Announce** | `publish("dsh.attention.requested")` | fire-and-forget, broadcast, many subscribers | phone push, LED, log, another agent |
| **Deliver** | `callTool("notify")` | 1:1, waits for a result, actually pops up | the user |

```yaml
signalPath: dsh.attention.requested
useSignal: true    # announce only: set useTool: false
useTool: true      # deliver only: set useSignal: false
```

A failed announcement never blocks delivery (and vice versa): the signal is a side channel,
popping up is the point.

### Icon

The notification icon is **inline base64**, not read from disk at runtime. `lib/icon.js` holds
the base64 of a 64×64 PNG (11.9 KB); `assets/` keeps the same PNG as the source image. Reading
a file at runtime brings a whole failure surface — package copied or mounted elsewhere, a
miscalculated relative path, and on Windows `new URL().pathname` yielding a `/F:/…` leading
slash (this one bit us once: the icon silently became `null`).

```yaml
notifyIcon: true                    # default: inline base64
notifyIconPath: C:/path/to/x.png    # override: only then is a file read; unreadable => fall back
# notifyIcon: false                 # no icon at all
```

`/msp/state` reports where the icon came from:
`{ok, source: "embedded"|"file"|"disabled", chars}`.

In the MCP content block, an image block with `annotations.role = "icon"` is used as the
notification icon (the peer echoes `"icon": "inline image (N chars)"` when it accepted it).
Throttling defaults to 3 s per title; if the preferred node is offline the notifier falls back
to any connected node that advertises `notify`.

## Tools shipped by the plugin

| Tool | Purpose |
|---|---|
| `msp_status` | Per-node connection state, endpoint and published tools; every node in the discovery directory with its lease age; notification switches, hook counters, icon status, long-task state |
| `msp_call_wait` | Call a tool and wait for it to finish: signal first, status polling as fallback, `pending` handle when the wait window expires |

## Long tasks (`msp_call_wait`)

The model sees a **synchronous call**; the host does the hard part.

```
msp_call_wait {node:"gd3", tool:"add_task", args:{urls:[...]}, waitMs:25000}
  → {status:"completed", via:"signal", taskId:"tsk_…", result:{files:[…]}}

  → {status:"pending", taskId:"tsk_…"}     # window expired; completion is recorded later
```

**Three layers, in priority order:**

| Layer | Role | Why it exists |
|---|---|---|
| Completion **signal** (`task.completed` …) | fast path, millisecond return | the point of subscribing at all |
| **Polling** a status tool (`get_task`) | fallback | signals are not retained, may be unauthorised (a publisher gates delivery with `grant_sub`), and are lost while disconnected |
| **Background watch** after the window | keeps the card alive | a long download must not freeze a turn |

Because polling always runs in parallel, **not knowing which signal means "done" is a performance
problem, never a correctness problem** — worst case the call is a few seconds slower.

**How the binding is learned.** The node's manifest already lists its signal paths, so the plugin
subscribes to all of them and matches observers against the handle returned by the start tool: the
first event whose payload contains that handle confirms the mapping, which is then cached in
`~/.dsh/dsh-msp/bindings.json`. Naming heuristics (`completed` / `failed`) seed the very first
attempt. Nothing has to be declared by the node author.

**When the window expires**, the task keeps being watched in the background; on completion one
record is appended (visible in `msp_status`) and a notification fires through the same channel as
the other hooks.

Note: nodes such as `gd3` publish **no progress signal** — `task.added`, `task.status`,
`task.completed`, `task.failed`, `task.removed` only. Progress therefore cannot stream into the
conversation; the panel can show it, the model sees the final result.

## Testing (no DSH required)

```bash
npm test                      # 6 suites: plugin entry, host routes, client bundle, notifier, prefs, turn tracker
node scripts/smoke.mjs        # drive the plugin with a fake ctx against the real MSP network
node scripts/probe-peers.mjs  # probe only: connect to fresh nodes, print tools/signals/capabilities
node scripts/call-peer.mjs <node> <tool> '{...}'   # call one tool on one node from the CLI
```

## Known limits

- **Only `request-reply`.** MSP broadcasts (`signal`) are ignored, so `notify.*`,
  `media.track.changed` and friends never reach the model's context.
- A changed tool schema under an unchanged name is not re-registered (to avoid interrupting a
  session); a node reconnect picks it up.
- No authentication: MSP's trust model on a local network is "reachable means trusted".
  Isolate it yourself before crossing machines.

## License

MIT
