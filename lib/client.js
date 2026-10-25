window.__ModuleLoader__.load({
	id: "dsh-msp",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const h = React.createElement;

		const PANEL_ID = "dsh-msp";
		const POLL_MS = 2000;

		/** 通知开关：key 与 host 侧 prefs 一致 */
		const NOTIFY_ITEMS = [
			{ key: "approval", label: "有操作等我确认", hint: "" },
			{ key: "question", label: "模型在问我问题", hint: "" },
			{ key: "turnEnd", label: "任务完成", hint: "仅长任务（≥20s）" },
		];

		// ---------------------------------------------------------------
		// 样式（内联，避免再来一条 CSS 构建链）
		// ---------------------------------------------------------------
		// 只用宿主真实存在的别名变量（--dsw-alias-label-* / bg-layer-* / border-l*），
		// 回退值一律用 inherit 或中性半透明灰 —— 绝不能回退成某个固定颜色：
		// 之前把 --dsw-alias-text-primary（这个版本里不存在）回退成 #e8e8ea，
		// 浅色主题下就是白字白底。
		const V = {
			text: "var(--dsw-alias-label-primary, inherit)",
			muted: "var(--dsw-alias-label-secondary, inherit)",
			faint: "var(--dsw-alias-label-tertiary, inherit)",
			border: "var(--dsw-alias-border-l2, rgba(127,127,127,0.28))",
			borderSoft: "var(--dsw-alias-border-l3, rgba(127,127,127,0.18))",
			surface: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))",
			surfaceRaised: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.09))",
			accent: "var(--dsw-alias-state-business-primary, #3d6cf0)",
			accentText: "var(--dsw-alias-label-primary-inverted, #ffffff)",
			success: "var(--dsw-alias-state-success-primary, #2f9e6b)",
			danger: "var(--dsw-alias-state-error-primary, #d9534f)",
		};

		const S = {
			page: {
				height: "100%", overflowY: "auto", padding: "18px 22px 40px",
				fontSize: 13, lineHeight: 1.55,
				color: V.text,
			},
			header: { display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 },
			title: { fontSize: 16, fontWeight: 600 },
			sub: { color: V.muted, fontSize: 12 },
			section: {
				marginTop: 18, padding: 14, borderRadius: 12,
				border: "1px solid " + V.border,
				background: V.surface,
			},
			sectionTitle: { color: V.muted, fontSize: 12, fontWeight: 600, marginBottom: 10, letterSpacing: 0.3 },
			row: { display: "flex", alignItems: "center", gap: 10 },
			chip: {
				display: "inline-block", padding: "1px 7px", marginRight: 6, marginBottom: 4,
				borderRadius: 999, fontSize: 11,
				color: V.text,
				border: "1px solid " + V.borderSoft,
				background: V.surfaceRaised,
				whiteSpace: "nowrap",
			},
			card: {
				padding: 12, borderRadius: 10, marginBottom: 10,
				border: "1px solid " + V.borderSoft,
				background: V.surfaceRaised,
			},
			mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, color: V.faint },
			dot: (on) => ({
				width: 8, height: 8, borderRadius: 999,
				background: on ? V.success : V.faint,
			}),
			toggle: (on) => ({
				cursor: "pointer", borderRadius: 999, padding: "3px 10px", fontSize: 11,
				border: "1px solid " + (on ? V.accent : V.border),
				color: on ? V.accentText : V.text,
				background: on ? V.accent : "transparent",
			}),
			hint: { color: V.faint, fontSize: 12 },
			feed: { fontSize: 11.5, color: V.text },
		};

		// ---------------------------------------------------------------
		// 侧栏图标
		// ---------------------------------------------------------------
		function MspIcon({ size }) {
			const s = size || 16;
			return h("svg", {
				"data-dsh-panel-entry": PANEL_ID,
				viewBox: "0 0 16 16", width: s, height: s, fill: "none",
				stroke: "currentColor", strokeWidth: "1.3",
				strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
			}, [
				h("circle", { key: "c", cx: "8", cy: "8", r: "2.2" }),
				h("circle", { key: "a", cx: "8", cy: "2.2", r: "1.2" }),
				h("circle", { key: "b", cx: "13", cy: "11", r: "1.2" }),
				h("circle", { key: "d", cx: "3", cy: "11", r: "1.2" }),
				h("path", { key: "l1", d: "M8 4.6v1.2M6.4 9.2 4.2 10.4M9.6 9.2l2.2 1.2" }),
			]);
		}

		// ---------------------------------------------------------------
		// 关系图：中心是本插件，外围是各 MSP 节点
		// ---------------------------------------------------------------
		function Graph({ peers }) {
			const W = 660, H = 300, cx = W / 2, cy = H / 2 + 6, R = 104;
			const n = Math.max(peers.length, 1);
			const nodes = peers.map((p, i) => {
				const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
				return { ...p, x: cx + Math.cos(angle) * R, y: cy + Math.sin(angle) * R };
			});
			const totalTools = peers.reduce((sum, p) => sum + p.tools.length, 0);

			return h("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H }, [
				// 边
				...nodes.map((n2) => h("line", {
					key: `e-${n2.key}`,
					x1: cx, y1: cy, x2: n2.x, y2: n2.y,
					stroke: n2.connected ? V.accent : "rgba(127,127,127,0.55)",
					strokeWidth: n2.connected ? 1.6 : 1,
					strokeDasharray: n2.connected ? "none" : "4 4",
					opacity: 0.9,
				})),
				// 中心节点
				h("circle", { key: "me", cx, cy, r: 26, fill: V.accent, opacity: 0.16 }),
				h("circle", { key: "me2", cx, cy, r: 16, fill: V.accent }),
				h("text", {
					key: "met", x: cx, y: cy + 38, textAnchor: "middle",
					fontSize: 11, fill: "currentColor", opacity: 0.75,
				}, `dsh-msp`),
				// 外围节点：半径按工具数放大
				...nodes.map((n2) => {
					const r = 9 + Math.min(n2.tools.length, 8) * 1.6;
					return h("g", { key: `n-${n2.key}` }, [
						h("circle", {
							cx: n2.x, cy: n2.y, r,
							fill: n2.connected ? V.surfaceRaised : "transparent",
							stroke: n2.connected ? V.success : "rgba(127,127,127,0.6)",
							strokeWidth: 1.6,
							strokeDasharray: n2.connected ? "none" : "3 3",
						}),
						h("text", {
							x: n2.x, y: n2.y + 3, textAnchor: "middle", fontSize: 10,
							fill: "currentColor", opacity: 0.85,
						}, String(n2.tools.length)),
						h("text", {
							x: n2.x, y: n2.y + r + 13, textAnchor: "middle", fontSize: 10.5,
							fill: "currentColor", opacity: 0.7,
						}, n2.nodeId),
					]);
				}),
				// 角标
				h("text", { key: "cap", x: 8, y: 16, fontSize: 10.5, fill: "currentColor", opacity: 0.45 },
					`${peers.filter((p) => p.connected).length}/${peers.length} 节点在线 · ${totalTools} 个工具`),
			]);
		}

		// ---------------------------------------------------------------
		// 页面
		// ---------------------------------------------------------------
		function MspPanel() {
			const [state, setState] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(null);

			const load = React.useCallback(async () => {
				try {
					const res = await fetch("/msp/state", { headers: { accept: "application/json" } });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const body = await res.json();
					setState(body);
					setError(null);
				} catch (err) {
					setError(String(err && err.message ? err.message : err));
				}
			}, []);

			React.useEffect(() => {
				let alive = true;
				const tick = () => { if (alive) load(); };
				tick();
				const timer = setInterval(tick, POLL_MS);
				return () => { alive = false; clearInterval(timer); };
			}, [load]);

			const toggleNotify = async (key, enabled) => {
				setBusy(`notify:${key}`);
				try {
					const res = await fetch("/msp/notify", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ key, enabled }),
					});
					const body = await res.json();
					if (body && body.ok) setState((prev) => (prev ? { ...prev, ...body } : body));
				} catch (err) {
					setError(String(err && err.message ? err.message : err));
				} finally {
					setBusy(null);
				}
			};

			const toggle = async (nodeId, enabled) => {
				setBusy(nodeId);
				try {
					const res = await fetch("/msp/node", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ nodeId, enabled }),
					});
					const body = await res.json();
					if (body && body.ok) setState((prev) => (prev ? { ...prev, ...body } : body));
				} catch (err) {
					setError(String(err && err.message ? err.message : err));
				} finally {
					setBusy(null);
				}
			};

			if (error) {
				return h("div", { style: S.page }, [
					h("div", { key: "t", style: S.title }, "MSP 网络"),
					h("div", { key: "e", style: { ...S.section, borderColor: V.danger } }, [
						h("div", { key: "a", style: S.sectionTitle }, "读不到状态"),
						h("div", { key: "b", style: S.hint }, error),
						h("div", { key: "c", style: { ...S.hint, marginTop: 8 } },
							"host 半端可能还没重启：路由 /msp/state 由 host 注册，改完 host 代码要重启 DSH。"),
					]),
				]);
			}

			if (!state) {
				return h("div", { style: S.page }, h("div", { style: S.hint }, "载入中…"));
			}

			const peers = Array.isArray(state.peers) ? state.peers : [];
			const calls = Array.isArray(state.calls) ? state.calls : [];
			const discovered = Array.isArray(state.discovered) ? state.discovered : [];
			const disabled = new Set((state.policy && state.policy.exclude) || []);
			const totalTools = peers.reduce((sum, p) => sum + p.tools.length, 0);

			return h("div", { style: S.page }, [
				// 头部
				h("div", { key: "h", style: S.header }, [
					h("div", { key: "t", style: S.title }, "MSP 网络"),
					h("div", { key: "s", style: S.sub },
						`${peers.filter((p) => p.connected).length}/${peers.length} 节点在线 · ${totalTools} 个工具 · ${state.nodesDir || ""}`),
				]),

				// 关系图
				h("div", { key: "g", style: S.section }, [
					h("div", { key: "t", style: S.sectionTitle }, "节点 / 工具关系"),
					h(Graph, { key: "svg", peers }),
				]),

				// 权限 + 工具
				h("div", { key: "p", style: S.section }, [
					h("div", { key: "t", style: S.sectionTitle }, "权限与工具"),
					peers.length === 0
						? h("div", { key: "none", style: S.hint }, "当前没有连上任何节点。")
						: h("div", {}, peers.map((p) => h("div", { key: p.key, style: S.card }, [
							h("div", { key: "r", style: { ...S.row, marginBottom: 6 } }, [
								h("span", { key: "d", style: S.dot(p.connected) }),
								h("span", { key: "n", style: { fontWeight: 600 } }, p.nodeId),
								h("span", { key: "e", style: { ...S.mono, opacity: 0.5 } },
									`${p.endpoint.host}:${p.endpoint.port}`),
								h("span", { key: "sp", style: { flex: 1 } }),
								h("button", {
									key: "b",
									style: S.toggle(!disabled.has(p.nodeId)),
									disabled: busy === p.nodeId,
									onClick: () => toggle(p.nodeId, disabled.has(p.nodeId)),
									title: "关闭后断开该节点、并摘掉它的工具",
								}, disabled.has(p.nodeId) ? "已禁用" : "已启用"),
							]),
							p.tools.length === 0
								? h("div", { key: "nt", style: S.hint }, "这个节点没有宣告工具")
								: h("div", { key: "tl" }, p.tools.map((t) => h("span", {
									key: t.dshName, style: S.chip, title: t.description || "",
								}, t.mspName + (t.params.length ? `(${t.params.join(", ")})` : "")))),
						]))),
				]),

				// 通知开关
				h("div", { key: "n", style: S.section }, [
					h("div", { key: "t", style: S.sectionTitle }, "通知（有事弹到灵动岛）"),
					...NOTIFY_ITEMS.map((item) => {
						const on = (state.notify || {})[item.key] === true;
						return h("div", { key: item.key, style: { ...S.row, padding: "3px 0" } }, [
							h("span", { key: "l", style: { flex: 1 } }, item.label),
							item.hint ? h("span", { key: "h", style: S.hint }, item.hint) : null,
							h("button", {
								key: "b",
								style: S.toggle(on),
								disabled: busy === `notify:${item.key}`,
								onClick: () => toggleNotify(item.key, !on),
							}, on ? "开" : "关"),
						]);
					}),
					h("div", { key: "hint", style: { ...S.hint, marginTop: 6 } },
						"选择保存到 ~/.dsh/dsh-msp/notify.json，重启后保持。"),
				]),

				// 动向
				h("div", { key: "a", style: S.section }, [
					h("div", { key: "t", style: S.sectionTitle }, "最近调用"),
					calls.length === 0
						? h("div", { key: "none", style: S.hint }, "还没有调用记录。")
						: h("div", { key: "l", style: S.feed }, calls.slice().reverse().map((c, i) => h("div", {
							key: `${c.at}-${i}`,
							style: { ...S.row, gap: 8, padding: "2px 0", opacity: c.ok ? 0.9 : 1 },
						}, [
							h("span", { key: "t", style: { ...S.mono, opacity: 0.45 } },
								new Date(c.at).toLocaleTimeString()),
							h("span", { key: "n", style: { opacity: 0.75 } }, c.nodeId),
							h("span", { key: "tl", style: S.mono }, c.dshName),
							h("span", { key: "r", style: { marginLeft: "auto", color: c.ok ? V.success : V.danger } },
								c.ok ? `${c.ms}ms` : (c.error || "失败")),
						]))),
				]),

				// 发现目录
				h("div", { key: "d", style: S.section }, [
					h("div", { key: "t", style: S.sectionTitle }, "发现目录"),
					h("div", { key: "l", style: S.feed },
						discovered.length === 0
							? h("span", { style: S.hint }, "（空）")
							: discovered.map((d) => h("span", { key: d.nodeId, style: S.chip }, [
								d.nodeId,
								h("span", { key: "a", style: { opacity: 0.5 } }, ` ${d.ageSeconds}s`),
							]))),
				]),
			]);
		}

		// ---------------------------------------------------------------
		// 注册
		// ---------------------------------------------------------------
		function apply(ctx) {
			const slots = ctx && ctx.slots;
			if (!slots) {
				// 少了 slots 服务（注入名对不上这个 DSH 版本）时安静退出：
				// 面板不出现，但不会影响其它插件与整页加载。
				try { console.warn("[dsh-msp] slots 服务不可用，MSP 面板未挂载"); } catch {}
				return () => {};
			}
			const disposers = [];
			disposers.push(slots.inject("sidebar.panellist", () => slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 40,
				label: () => "MSP",
			}, MspIcon)));
			disposers.push(slots.inject("main", () => slots.register({
				name: "main",
				key: PANEL_ID,
			}, MspPanel)));
			return () => {
				for (const dispose of disposers.splice(0)) dispose();
			};
		}

		module.exports = { apply, inject: ["slots"] };
		return module.exports;
	}
});
