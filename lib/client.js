/*
 * dsh-workbuddy-summon — browser half
 *
 * 挂进 `conversation.input.right`（提交按钮前的紧凑控件区），一个「召唤」按钮 +
 * portal 面板：搜索 / 分类 / 三个 tab（专家团·专家·市场）。目录口径与 WorkBuddy 专家中心一致；
 * 「市场」是在线专家市场（28k+ 条，需 WorkBuddy 登录态 token），宿主接口见 lib/market.js。
 *
 * 卡片口径（对齐 WorkBuddy 专家中心）：主标题 = profession（如「中文网络小说创作顾问」），
 * 副标题 = name 花名（如「网文主编」），两者相同时隐藏副标题；专家团额外给成员数 / 成员头像。
 *
 * 要点（本机踩过的坑）：
 *   · factory id 必须等于包名，否则设置页按 {only: row.id} 过滤会落空白行；
 *   · slot 出口是 display:contents，容器 rect 全是 0 → 浮层必须 portal 到 body；
 *   · 官方 overlay 天花板 z-index 20，取 15；
 *   · 样式与监听都在 apply 里用 ctx.effect 注册并返回清理函数；
 *   · 幂等守卫必须有，撞 id 会中断同 bundle 后续全部模块注册；
 *   · 只改本文件内容 → 刷新页面即可生效；新增/移除 client 半边 → 必须重启应用。
 *
 * 设计纪律：全部规则锚 .wbsum-* 根类；官方 --dsw-* token；radius 四档；
 * 动效 120/160ms + ease；焦点环 focus-ring；reduced-motion 降级；不碰宿主 DOM。
 */
if (!window.__dshWbSummonRegistered) {
	window.__dshWbSummonRegistered = true;
	window.__ModuleLoader__.load({
		id: "dsh-workbuddy-summon",
		factory: (require) => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

			const React = require("react");
			const ReactDOM = require("react-dom");
			const h = React.createElement;

			const BASE = "/dsh-workbuddy-summon";
			const STYLE_ID = "dsh-wb-summon-style";
			const NS = "workbuddy-summon";
			const TAB_ORDER = ["team", "expert", "market"];
			/* tab → 词典 key。文案集中在这里，避免新增 tab 时漏改某一处。 */
			const TAB_LABEL = { team: "tabTeam", expert: "tabExpert", market: "tabMarket" };

			/* 列表数据获取策略（纯函数，便于离线回归 —— 见 tests/tab-switch-check.mjs）
			 *   切 tab    → 立刻换成目标 tab 的缓存；没有缓存就返回 null（骨架态）。
			 *              绝不继续摆着上一个 tab 的列表，那比闪一下更糟。
			 *   同 tab 内改搜索词/分类 → 返回 undefined（= 不动列表），后台刷新，不闪。
			 */
			function listSeed(cache, prevKind, kind, key) {
				const cached = cache.get(key);
				const switched = prevKind !== kind;
				return { cached, switched, seed: switched ? cached ?? null : undefined };
			}

			/* ───────────────────── 市场条目归一（纯函数，便于离线回归） ─────────────────────
			 * 宿主可能给「扁平字段」（title / name / category / summary，见路由契约），
			 * 也可能给 WorkBuddy 原味的 {zh, en} 结构（lib/market.js 的 marketItemToEntry）。
			 * 两种都认，避免卡片出现 "[object Object]"；avatarUrl 优先，avatar 只在是绝对 URL 时兜底。
			 */
			function pickText(v) {
				if (typeof v === "string") return v;
				if (v === null || typeof v !== "object") return "";
				const zh = v.zh ?? v["zh-CN"] ?? v.zh_CN;
				if (typeof zh === "string" && zh.length > 0) return zh;
				const en = v.en ?? v["en-US"] ?? v.en_US;
				return typeof en === "string" ? en : "";
			}

			function marketItemOf(it) {
				const title = pickText(it.title) || pickText(it.profession) || pickText(it.displayName) || "";
				const name = pickText(it.name) || pickText(it.displayName) || "";
				const avatar =
					typeof it.avatarUrl === "string" && it.avatarUrl.length > 0
						? it.avatarUrl
						: typeof it.avatar === "string" && /^https?:\/\//.test(it.avatar)
							? it.avatar
							: undefined;
				return {
					...it,
					title,
					name: name === title ? "" : name,
					category: pickText(it.category) || pickText(it.categoryName) || "",
					summary: pickText(it.summary) || pickText(it.description) || "",
					avatarUrl: avatar,
					marketExpertId:
						typeof it.marketExpertId === "string" && it.marketExpertId.length > 0
							? it.marketExpertId
							: typeof it.id === "string" && it.id.length > 0
								? it.id
								: undefined,
					useCount: Number.isFinite(Number(it.useCount)) ? Number(it.useCount) : 0,
				};
			}

			function normalizeMarketItems(list) {
				if (!Array.isArray(list)) return [];
				return list.filter((it) => it !== null && typeof it === "object").map(marketItemOf);
			}

			function installStyle() {
				if (document.getElementById(STYLE_ID)) return () => {};
				const el = document.createElement("style");
				el.id = STYLE_ID;
				el.textContent = [
					/* 动效 token：锚在插件自己的两个根上，不进 :root、不碰宿主 DOM。
					   ease-out 用 strong 曲线 —— 内置 ease 太弱，入场会显得犹豫。 */
					`.wbsum-btn,.wbsum-panel{--wb-ease-out:cubic-bezier(.32,.72,.35,1);--wb-dur-fast:120ms;--wb-dur-base:160ms}`,
					`.wbsum-btn{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:var(--dsw-radius-sm);border:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;white-space:nowrap;transition:background var(--wb-dur-fast) ease,color var(--wb-dur-fast) ease,transform 160ms ease-out}`,
					`.wbsum-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-btn:active{transform:scale(.97)}`,
					`.wbsum-btn[data-active="1"]{color:var(--dsw-alias-brand-primary);font-weight:600}`,
					`.wbsum-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}`,
					`.wbsum-caret{font-size:9px;opacity:.55}`,
					/* 进出场走 transition 而不是 keyframes：快速开关时能从当前状态retarget，
					   不会「重播」。入场 150ms strong ease-out，退场 110ms（退场必须比入场快）。 */
					`.wbsum-panel{position:fixed;z-index:15;width:min(392px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:min(560px,72vh);max-height:min(560px,72dvh);padding-bottom:env(safe-area-inset-bottom,0px);display:flex;flex-direction:column;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);border-radius:var(--dsw-radius-lg);border:0;overflow:hidden;transform-origin:bottom center;opacity:0;transform:translateY(8px) scale(.97);transition:opacity var(--wb-dur-base) var(--wb-ease-out),transform var(--wb-dur-base) var(--wb-ease-out)}`,
`@media(max-width:640px){.wbsum-panel{width:100%;inset:auto 0 0 0;border-radius:16px 16px 0 0}}`,
					/* H5：面板改成整屏（≤1023，与 pocket / h5-adapter 同一断点）。openPanel() 会往
					   元素上写内联 left/bottom/maxHeight，锚在按钮上沿，实测
					   415×923 时 top=-377、大半跑出屏幕；author-important 压得过 inline-normal，
					   所以这里必须 !important。整屏后「点面板外面关闭」够不到，头部右侧补一个关闭键
					   （桌面 display:none，原有交互不变）。 */
					`@media (max-width:1023px){
						.wbsum-panel[role="dialog"]{inset:0 !important;left:0 !important;right:0 !important;top:0 !important;bottom:0 !important;width:auto !important;max-width:none !important;height:auto !important;max-height:none !important;border-radius:0 !important;z-index:1300 !important;transform-origin:center top;padding-top:env(safe-area-inset-top,0px)}
						.wbsum-head{position:relative;padding-right:46px !important}
						.wbsum-close{display:flex !important}
						.wbsum-list{padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}
					}`,
					`.wbsum-close{display:none;position:absolute;top:6px;right:8px;width:32px;height:32px;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:20px;line-height:1;cursor:pointer;transition:background var(--wb-dur-fast) ease,color var(--wb-dur-fast) ease,transform 160ms ease-out}`,
					`.wbsum-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
					`.wbsum-close:active{transform:scale(.94)}`,
`.wbsum-btn,.wbsum-tab,.wbsum-act{position:relative}`,
`.wbsum-btn::after,.wbsum-tab::after,.wbsum-act::after{content:"";position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);height:44px;min-height:44px}`,
					`.wbsum-panel[data-state="open"]{opacity:1;transform:none}`,
					`.wbsum-panel[data-state="closing"]{opacity:0;transform:translateY(4px) scale(.98);transition-duration:110ms}`,
					/* 入场前值：没有它，元素首帧直接是终值，transition 不会播。
					   不支持该 at-rule 的环境降级为「无动画但正常显示」，安全。 */
					`@starting-style{.wbsum-panel[data-state="open"]{opacity:0;transform:translateY(8px) scale(.97)}}`,
					`@keyframes wbsum-fade-in{from{opacity:0}to{opacity:1}}`,
					`@media (prefers-reduced-motion: reduce){.wbsum-panel{transition:opacity 110ms ease}.wbsum-panel[data-state="open"],.wbsum-panel[data-state="closing"]{transform:none}.wbsum-list{animation:none}}`,
					`.wbsum-head,.wbsum-cur{border-bottom:.5px solid var(--dsw-alias-border-l3)}`,
					`.wbsum-foot{border-top:.5px solid var(--dsw-alias-border-l3)}`,
					`.wbsum-head{padding:8px 10px 6px}`,
					`.wbsum-search{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:var(--dsw-radius-sm);border:0;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);outline:none;transition:box-shadow .12s ease}`,
					`.wbsum-search:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}`,
					`.wbsum-search::placeholder{color:var(--dsw-alias-label-tertiary)}`,
					`.wbsum-tabrow{display:flex;align-items:center;gap:8px;margin-top:6px}`,
					/* 分段选择器：与 card-summon 同款 —— 轨道 = interactive-bg-hover，
					   每颗按钮自己浮起（bg-base + hairline 描边），无滑动 thumb。 */
					`.wbsum-tabs{display:inline-grid;grid-template-columns:repeat(3,minmax(44px,1fr));align-items:center;padding:2px;gap:2px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-tab{box-sizing:border-box;height:22px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;transition:background var(--wb-dur-fast) ease,color var(--wb-dur-fast) ease,box-shadow var(--wb-dur-fast) ease,transform 160ms ease-out;white-space:nowrap}`,
					`.wbsum-tab:hover{color:var(--dsw-alias-label-primary)}`,
					`.wbsum-tab:active{transform:scale(.97)}`,
					`.wbsum-tab[aria-selected="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 0.5px var(--dsw-alias-border-l2)}`,
					`.wbsum-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}`,
					`.wbsum-select{margin-left:auto;width:fit-content;padding:2px 6px;border-radius:var(--dsw-radius-sm);font:var(--dsw-font-xxs-12);background:transparent;color:var(--dsw-alias-label-secondary);border:0;cursor:pointer;transition:background var(--wb-dur-fast) ease}`,
					`.wbsum-select:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-list{flex:1;min-height:0;overflow-y:auto;padding:4px 4px 6px;animation:wbsum-fade-in 140ms var(--wb-ease-out) both;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}`,
					`.wbsum-item{display:flex;align-items:flex-start;gap:9px;width:100%;text-align:left;padding:7px 9px;border-radius:var(--dsw-radius-md);border:0;background:transparent;color:inherit;font:var(--dsw-font-xxs-12);cursor:pointer;transition:background var(--wb-dur-fast) ease,box-shadow var(--wb-dur-base) var(--wb-ease-out),opacity 140ms ease,transform 160ms ease-out}`,
					`.wbsum-item:active{transform:scale(.99)}`,
					`.wbsum-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}`,
					`.wbsum-item:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-item:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}`,
					`.wbsum-item[data-on="1"]{background:var(--dsw-alias-bg-layer-1);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-soft)}`,
					`.wbsum-ava{margin-top:1px;width:28px;height:28px;flex:0 0 28px;border-radius:50%;object-fit:cover;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;line-height:1;overflow:hidden}`,
					`.wbsum-btn-ava{width:16px;height:16px;flex:0 0 16px;border-radius:50%;object-fit:cover;background:var(--dsw-alias-bg-layer-2);display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;line-height:1;overflow:hidden}`,
					/* 专家团成员头像堆叠：最多 3 张，重叠 4px，环用面板底色盖住下一张 */
					`.wbsum-stack{display:inline-flex;align-items:center;flex:0 0 auto}`,
					`.wbsum-stack .wbsum-btn-ava{margin-left:-4px;box-shadow:0 0 0 1.5px var(--dsw-specific-menu)}`,
					`.wbsum-stack .wbsum-btn-ava:first-child{margin-left:0}`,
					`.wbsum-more{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}`,
					`.wbsum-row1{display:flex;align-items:baseline;gap:6px}`,
					`.wbsum-name{font:var(--dsw-font-xxs-strong-12)}`,
					`.wbsum-prof{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}`,
					`.wbsum-badge{margin-left:auto;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);white-space:nowrap;display:inline-flex;align-items:center;gap:5px}`,
					`.wbsum-desc{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}`,
					`.wbsum-cur{padding:6px 10px;display:flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-1)}`,
					`.wbsum-curname{font:var(--dsw-font-xxs-strong-12);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
					`.wbsum-act{padding:3px 9px;border-radius:var(--dsw-radius-sm);border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;transition:background var(--wb-dur-fast) ease,color var(--wb-dur-fast) ease,transform 160ms ease-out;white-space:nowrap}`,
					`.wbsum-act:active{transform:scale(.97)}`,
					`.wbsum-act:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
					`.wbsum-note{padding:10px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:1.5}`,
					`.wbsum-err{margin:0 10px 6px;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12);white-space:pre-wrap;max-height:120px;overflow-y:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}`,
					`.wbsum-foot{padding:6px 10px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);display:flex;gap:8px;align-items:center}`,
					`.wbsum-dots{letter-spacing:1px}`,
					/* ── 市场（在线专家市场）──────────────────────────────────────
					   与目录共用面板骨架；连接卡片 / token 输入 / 加载更多是市场专属。
					   色彩只用面板里已验证过的 token 组合（brand = 强调文字色，不铺满底色），
					   避免深色模式下出现「蓝底白字」这类不可控对比。 */
					`.wbsum-market-connect{display:flex;flex-direction:column;gap:6px;margin:2px 4px;padding:10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-soft)}`,
					`.wbsum-market-title{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-primary)}`,
					`.wbsum-market-desc{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:1.5}`,
					`.wbsum-market-sub{margin-top:2px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-strong-12)}`,
					`.wbsum-market-row{display:flex;align-items:center;gap:6px}`,
					`.wbsum-market-btn{flex:0 0 auto;height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:0;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary);font:var(--dsw-font-xxs-strong-12);cursor:pointer;white-space:nowrap;transition:background var(--wb-dur-fast) ease,opacity var(--wb-dur-fast) ease,transform 160ms ease-out}`,
					`.wbsum-market-btn:hover{background:var(--dsw-alias-bg-layer-2)}`,
					`.wbsum-market-btn:active{transform:scale(.97)}`,
					`.wbsum-market-btn:disabled{opacity:.55;cursor:default}`,
					`.wbsum-market-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}`,
					`.wbsum-market-token{flex:1;min-width:0;height:24px;box-sizing:border-box;padding:0 8px;border-radius:var(--dsw-radius-sm);border:0;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);outline:none}`,
					`.wbsum-market-token:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}`,
					`.wbsum-market-token::placeholder{color:var(--dsw-alias-label-tertiary)}`,
					`.wbsum-market-hint{padding:6px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);line-height:1.5;white-space:pre-wrap}`,
					`.wbsum-market-err{margin:0}`,
					`.wbsum-market-more-row{display:flex;align-items:center;justify-content:center;padding:6px 4px 2px}`,
					`.wbsum-market-all{padding:4px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}`,
					`.wbsum-badge-market{padding:0 4px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary);font:var(--dsw-font-xxs-12);line-height:1.4}`,
				].join("\n");
				document.head.appendChild(el);
				return () => {
					try {
						el.remove();
					} catch {
						/* 已被移除 */
					}
				};
			}

			/* ───────────────────── 数据访问 ───────────────────── */
			async function apiCatalog(params) {
				const qs = new URLSearchParams(params || {}).toString();
				const res = await fetch(`${BASE}/catalog${qs ? `?${qs}` : ""}`, { headers: { Accept: "application/json" } });
				const data = await res.json().catch(() => ({}));
				if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
				return data;
			}
			async function apiStatus(sessionId) {
				const res = await fetch(`${BASE}/status?sessionId=${encodeURIComponent(sessionId ?? "")}`, {
					headers: { Accept: "application/json" },
				});
				const data = await res.json().catch(() => ({}));
				if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
				return data;
			}
			async function apiPost(path, body) {
				const res = await fetch(`${BASE}${path}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				const data = await res.json().catch(() => ({}));
				if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
				return data;
			}

			/* ───────────────────── 市场接口（0.3.0 宿主） ─────────────────────
			 * 与目录接口的差别：必须保留 HTTP 状态与 hint ——
			 *   · /market/status 404 → 旧宿主没有市场能力，tab 显示不可用而不是崩掉；
			 *   · capture 失败 → hint 里是「用调试端口重启 WorkBuddy」的操作指引，要原样显示。
			 */
			async function apiMarket(path, body) {
				const res = await fetch(
					`${BASE}${path}`,
					body === undefined
						? { headers: { Accept: "application/json" } }
						: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
				);
				const data = await res.json().catch(() => ({}));
				if (!res.ok || data.ok === false) {
					const error = new Error(data.error || `HTTP ${res.status}`);
					error.status = res.status;
					if (typeof data.hint === "string" && data.hint.length > 0) error.hint = data.hint;
					throw error;
				}
				return data;
			}
			const apiMarketStatus = () => apiMarket("/market/status");
			const apiMarketCapture = (port) => apiMarket("/market/capture", { port });
			const apiMarketToken = (token) => apiMarket("/market/token", { token });
			function apiMarketSearch(params) {
				const qs = new URLSearchParams();
				if (typeof params.q === "string" && params.q.length > 0) qs.set("q", params.q);
				if (typeof params.category === "string" && params.category.length > 0) qs.set("category", params.category);
				qs.set("page", String(params.page ?? 1));
				qs.set("pageSize", String(params.pageSize ?? 30));
				return apiMarket(`/market/search?${qs.toString()}`);
			}

			/* 列表方向键导航：在容器内 .wbsum-item 按钮间移动焦点（各 tab 复用）。 */
			function listKeyHandler(e) {
				if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
				const btns = [...e.currentTarget.querySelectorAll("button.wbsum-item")];
				if (btns.length === 0) return;
				e.preventDefault();
				const i = btns.indexOf(document.activeElement);
				const n = i === -1 ? 0 : Math.min(btns.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
				btns[n]?.focus?.();
			}

			/* ───────────────────── 头像 ─────────────────────
			 * URL 直接由 plugin 拼（宿主路由自己查目录与缩略图），这样连改动前
			 * 写下的旧召唤状态也能显示头像。取不到图时回退首字，不留空洞。
			 * 专家团成员头像多带一个 agent 参数：宿主按 plugin 的 members[].id 查 member.avatar。
			 */
			const AVATAR_BASE = `${BASE}/avatar`;
			function avatarSrc(plugin, size, agent) {
				if (typeof plugin !== "string" || plugin.length === 0) return null;
				const agentQs = typeof agent === "string" && agent.length > 0 ? `&agent=${encodeURIComponent(agent)}` : "";
				return `${AVATAR_BASE}?plugin=${encodeURIComponent(plugin)}&size=${size ?? 64}${agentQs}`;
			}
			function Avatar(props) {
				const cls = props.small === true ? "wbsum-btn-ava" : "wbsum-ava";
				const initial = String(props.name ?? props.plugin ?? "?").trim().charAt(0) || "?";
				const [failed, setFailed] = React.useState(false);
				const src = props.src !== undefined ? props.src : avatarSrc(props.plugin, props.size, props.agent);
				if (src === null || failed === true) {
					return h("span", { className: cls, "aria-hidden": "true" }, initial);
				}
				return h("img", {
					className: cls,
					src,
					alt: "",
					loading: "lazy",
					draggable: false,
					onError: () => setFailed(true),
				});
			}

			/* 专家团成员头像堆叠（对齐 WorkBuddy 专家中心卡片）：最多 3 张，其余折成 +N。
			 * 服务端没给成员清单时整块不渲染，退化成徽标里的成员数 —— 不报错、不留空洞。 */
			function MemberStack(props) {
				const members = Array.isArray(props.members)
					? props.members.filter((m) => m !== null && typeof m === "object" && typeof m.id === "string")
					: [];
				if (members.length === 0) return null;
				const shown = members.slice(0, 3);
				const rest = members.length - shown.length;
				return h(
					"span",
					{ className: "wbsum-stack", "aria-hidden": "true" },
					shown.map((m) => h(Avatar, { key: m.id, small: true, agent: m.id, plugin: props.plugin, name: m.name })),
					rest > 0 ? h("span", { className: "wbsum-more" }, `+${rest}`) : null,
				);
			}

			/* ───────────────────── 市场：未连接态卡片 ─────────────────────
			 * 两条连接途径并列：一键抓 token（要求 WorkBuddy 带 --remote-debugging-port 启动）
			 * 与手动粘贴 token。失败时把宿主给的 hint 原样放出来 —— 那是重启指引，不能吞。
			 */
			function MarketConnectCard(props) {
				const { t, busy, error, hint, token } = props;
				return h(
					"div",
					{ className: "wbsum-market-connect" },
					h("div", { className: "wbsum-market-title" }, t("marketDisconnected")),
					h("div", { className: "wbsum-market-desc" }, t("marketDisconnectedHint")),
					h(
						"div",
						{ className: "wbsum-market-row" },
						h(
							"button",
							{ className: "wbsum-market-btn", type: "button", disabled: busy, onClick: props.onCapture },
							busy ? t("marketConnecting") : t("marketConnect"),
						),
					),
					error !== null && error !== undefined
						? h("div", { className: "wbsum-err wbsum-market-err", role: "alert" }, error)
						: null,
					hint !== null && hint !== undefined ? h("div", { className: "wbsum-market-hint" }, hint) : null,
					h("div", { className: "wbsum-market-sub" }, t("marketManualToken")),
					h(
						"div",
						{ className: "wbsum-market-row" },
						h("input", {
							className: "wbsum-market-token",
							type: "password",
							value: token,
							placeholder: t("marketTokenPlaceholder"),
							"aria-label": t("marketTokenPlaceholder"),
							autoComplete: "off",
							spellCheck: false,
							onChange: (e) => props.onTokenChange(e.target.value),
						}),
						h(
							"button",
							{
								className: "wbsum-market-btn",
								type: "button",
								disabled: busy || token.trim().length === 0,
								onClick: props.onTokenSubmit,
							},
							t("marketSubmitToken"),
						),
					),
				);
			}

			/* ───────────────────── 面板 ───────────────────── */
			function SummonPanel(props) {
				const { sessionId, current, pos, onClose, onChanged, t, phase } = props;
				const [kind, setKind] = React.useState("team");
				const [q, setQ] = React.useState("");
				const [debounced, setDebounced] = React.useState("");
				const [category, setCategory] = React.useState("");
				const [data, setData] = React.useState(null);
				const [error, setError] = React.useState(null);
				const [busy, setBusy] = React.useState(false);
				// 按 key 缓存列表：切回看过的 tab 直接出内容，只有没见过的 key 才进骨架态，
				// 避免每次切换都闪一下空列表。
				const cacheRef = React.useRef(new Map());
				// 上一次真正发起过请求的「tab」，用来区分「切 tab」与「同 tab 内改查询」。
				const prevKindRef = React.useRef(null);
				const boxRef = React.useRef(null);
				const inputRef = React.useRef(null);

				/* 市场（在线专家市场）自带一套状态：与官方目录的 data/error 完全隔离，
				   切 tab 时各留各的，互不覆盖。mState 是市场的生命周期：
				   idle/loading → ready（拿到 connected 布尔）｜unavailable（旧宿主 404）｜error。 */
				const [mState, setMState] = React.useState("idle");
				const [mConnected, setMConnected] = React.useState(false);
				const [mCats, setMCats] = React.useState([]);
				const [mConnError, setMConnError] = React.useState(null);
				const [mHint, setMHint] = React.useState(null);
				const [mBusy, setMBusy] = React.useState(false);
				const [mToken, setMToken] = React.useState("");
				const [mCategory, setMCategory] = React.useState("");
				const [mItems, setMItems] = React.useState([]);
				const [mTotal, setMTotal] = React.useState(0);
				const [mPage, setMPage] = React.useState(1);
				const [mLoading, setMLoading] = React.useState(false);
				const [mMore, setMMore] = React.useState(false);
				const [mEnd, setMEnd] = React.useState(false);
				const [mError, setMError] = React.useState(null);
				const [mEpoch, setMEpoch] = React.useState(0);

				/* 市场请求失败：401 = token 过期（JWT 有 exp），直接退回未连接态让用户重新连接，
				   error/hint 由连接卡片显示；其余错误留在列表上方的 role=alert。 */
				const marketSearchFailed = (e) => {
					const message = String(e?.message ?? e);
					setMItems([]);
					setMTotal(0);
					if (e?.status === 401) {
						setMConnected(false);
						setMConnError(message);
						setMHint(typeof e?.hint === "string" && e.hint.length > 0 ? e.hint : null);
						return;
					}
					setMError(message);
				};

				React.useEffect(() => {
					// 市场是 28k+ 条在线服务，防抖给 300ms；官方目录命中本机快照，260ms 够。
					const timer = setTimeout(() => setDebounced(q.trim()), kind === "market" ? 300 : 260);
					return () => clearTimeout(timer);
				}, [q, kind]);

				React.useEffect(() => {
					// 市场 tab 走独立数据源，绝不拿 kind=market 去问官方目录路由。
					if (kind === "market") {
						prevKindRef.current = kind;
						setData(null);
						return undefined;
					}
					const key = `${kind}|${debounced}|${category}`;
					const { cached, seed } = listSeed(cacheRef.current, prevKindRef.current, kind, key);
					prevKindRef.current = kind;
					let alive = true;
					// seed === undefined → 同 tab 内改查询，保留旧列表；否则按上面的策略换。
					if (seed !== undefined) setData(seed);
					setError(null);
					apiCatalog({
						kind,
						...(debounced.length > 0 ? { q: debounced } : {}),
						...(category.length > 0 ? { category } : {}),
					})
						.then((d) => {
							if (!alive) return;
							cacheRef.current.set(key, d);
							setData(d);
						})
						.catch((e) => {
							if (!alive) return;
							setError(String(e?.message ?? e));
							if (cached !== undefined) setData(cached);
						});
					return () => {
						alive = false;
					};
				}, [kind, debounced, category]);

				/* 进入市场 tab 先问宿主「连没连」（连接成功后 mEpoch 自增，这里重取一次）。
				   404 = 旧宿主没有市场能力 → 只降级提示，不影响其他 tab。 */
				React.useEffect(() => {
					if (kind !== "market") return undefined;
					let alive = true;
					setMState("loading");
					setMError(null);
					apiMarketStatus()
						.then((d) => {
							if (!alive) return;
							setMConnected(d.connected === true);
							setMCats(Array.isArray(d.categories) ? d.categories : []);
							setMHint(typeof d.hint === "string" && d.hint.length > 0 ? d.hint : null);
							setMState("ready");
						})
						.catch((e) => {
							if (!alive) return;
							if (e?.status === 404) {
								setMConnected(false);
								setMState("unavailable");
								return;
							}
							setMState("error");
							setMError(String(e?.message ?? e));
						});
					return () => {
						alive = false;
					};
				}, [kind, mEpoch]);

				/* 已连接后按「关键词 + 分类」查第一页；翻页由「加载更多」单独追加。 */
				React.useEffect(() => {
					if (kind !== "market" || !mConnected) return undefined;
					let alive = true;
					setMLoading(true);
					setMError(null);
					apiMarketSearch({ q: debounced, category: mCategory, page: 1, pageSize: 30 })
						.then((d) => {
							if (!alive) return;
							setMItems(normalizeMarketItems(d.items));
							setMTotal(Number(d.total) || 0);
							setMPage(1);
							setMEnd(false);
						})
						.catch((e) => {
							if (!alive) return;
							marketSearchFailed(e);
						})
						.finally(() => {
							if (alive) setMLoading(false);
						});
					return () => {
						alive = false;
					};
				}, [kind, mConnected, debounced, mCategory, mEpoch]);

				React.useEffect(() => {
					const onDoc = (ev) => {
						if (boxRef.current !== null && !boxRef.current.contains(ev.target)) onClose();
					};
					const onKey = (ev) => {
						if (ev.key === "Escape") onClose();
					};
					// 面板要能接住第一次外部点击，延一帧再挂监听
					const timer = setTimeout(() => {
						document.addEventListener("mousedown", onDoc, true);
						document.addEventListener("keydown", onKey, true);
					}, 0);
					inputRef.current?.focus?.();
					return () => {
						clearTimeout(timer);
						document.removeEventListener("mousedown", onDoc, true);
						document.removeEventListener("keydown", onKey, true);
					};
				}, [onClose]);

				/* 市场条目多带一个 marketExpertId：宿主据此下载签名包再装（本地目录条目没有）。 */
				const doSummon = async (item, market) => {
					if (sessionId === undefined || busy) return;
					setBusy(true);
					setError(null);
					try {
						const body = { sessionId, plugin: item.plugin ?? item.marketExpertId };
						if (market === true && typeof item.marketExpertId === "string" && item.marketExpertId.length > 0) {
							body.marketExpertId = item.marketExpertId;
						}
						const r = await apiPost("/summon", body);
						onChanged(r);
						onClose();
					} catch (e) {
						setError(String(e?.message ?? e));
					} finally {
						setBusy(false);
					}
				};

				const doClear = async () => {
					if (sessionId === undefined || busy) return;
					setBusy(true);
					try {
						await apiPost("/unsummon", { sessionId });
						onChanged(null);
					} catch (e) {
						setError(String(e?.message ?? e));
					} finally {
						setBusy(false);
					}
				};

				/* 连接成功的响应已经是「status 形状」：直接吸收，再 bump 一次 epoch 让
				   status 与首页搜索各自重跑（和进入 tab 走同一条路径，少一套分支）。 */
				const absorbMarket = (d) => {
					setMConnected(d?.connected === true);
					if (Array.isArray(d?.categories) && d.categories.length > 0) setMCats(d.categories);
				};
				const marketFailed = (e) => {
					setMConnError(String(e?.message ?? e));
					setMHint(typeof e?.hint === "string" && e.hint.length > 0 ? e.hint : null);
				};
				const doCapture = async () => {
					if (mBusy) return;
					setMBusy(true);
					setMConnError(null);
					setMHint(null);
					try {
						absorbMarket(await apiMarketCapture(9222));
						setMState("ready");
						setMEpoch((n) => n + 1);
					} catch (e) {
						marketFailed(e);
					} finally {
						setMBusy(false);
					}
				};
				const doTokenSubmit = async () => {
					const token = mToken.trim();
					if (mBusy || token.length === 0) return;
					setMBusy(true);
					setMConnError(null);
					setMHint(null);
					try {
						absorbMarket(await apiMarketToken(token));
						setMToken("");
						setMState("ready");
						setMEpoch((n) => n + 1);
					} catch (e) {
						marketFailed(e);
					} finally {
						setMBusy(false);
					}
				};
				/* 加载更多：page 递增、结果追加（不替换）；空页就收尾，按钮换「已全部加载」。 */
				const doLoadMore = async () => {
					if (mMore || mLoading || !mConnected) return;
					const next = mPage + 1;
					setMMore(true);
					setMError(null);
					try {
						const d = await apiMarketSearch({ q: debounced, category: mCategory, page: next, pageSize: 30 });
						const more = normalizeMarketItems(d.items);
						setMItems((prev) => prev.concat(more));
						if (Number.isFinite(Number(d.total))) setMTotal(Number(d.total));
						setMPage(next);
						if (more.length === 0) setMEnd(true);
					} catch (e) {
						// 翻页失败不清已加载的列表；只有 token 过期才退回未连接态。
						if (e?.status === 401) marketSearchFailed(e);
						else setMError(String(e?.message ?? e));
					} finally {
						setMMore(false);
					}
				};

				const onTabKey = (e) => {
					if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
					e.preventDefault();
					const i = TAB_ORDER.indexOf(kind);
					const n = (i + (e.key === "ArrowRight" ? 1 : TAB_ORDER.length - 1)) % TAB_ORDER.length;
					setKind(TAB_ORDER[n]);
					e.currentTarget.querySelectorAll("[role=tab]")[n]?.focus?.();
				};

				const visible = data?.items ?? [];
				const cats = (data?.categories ?? []).filter((c) => c.count > 2);
				const marketHasMore = mConnected && !mEnd && mTotal > 0 && mItems.length < mTotal;

				/* 卡片口径对齐 WorkBuddy 专家中心：
				 *   主标题 = profession（如「中文网络小说创作顾问」），缺省回落到 title / name / plugin；
				 *   副标题 = name 花名（如「网文主编」），与主标题相同时隐藏；
				 *   专家团在徽标里给成员数，成员清单到位时右侧再叠最多 3 张成员头像。
				 * market=true 时多给一个「市场」小徽标，召唤时带 marketExpertId。
				 */
				const renderItem = (it, market) => {
					const title = pickText(it.profession) || pickText(it.title) || pickText(it.name) || it.plugin || "";
					const nameText = pickText(it.name);
					const subtitle = nameText.length > 0 && nameText !== title ? nameText : null;
					const isTeam = it.expertType === "team";
					const memberCount = Number(it.memberCount) || 0;
					const teamLabel = memberCount > 0 ? `${t("teamTag")}·${memberCount + 1}` : t("teamTag");
					const on = market === true
						? current?.marketExpertId !== undefined && current.marketExpertId === it.marketExpertId ? "1" : "0"
						: current?.plugin === it.plugin ? "1" : "0";
					return h(
						"button",
						{
							key: market === true ? `market::${it.marketExpertId ?? it.plugin ?? title}` : `${it.plugin}::${it.id}`,
							className: "wbsum-item",
							"data-on": on,
							disabled: busy,
							title: subtitle === null ? title : `${title} · ${subtitle}`,
							onClick: () => doSummon(it, market === true),
						},
						h(Avatar, { plugin: it.plugin, name: title, src: it.avatarUrl }),
						h(
							"div",
							{ className: "wbsum-main" },
							h(
								"div",
								{ className: "wbsum-row1" },
								h("span", { className: "wbsum-name" }, title),
								subtitle === null ? null : h("span", { className: "wbsum-prof" }, subtitle),
								h(
									"span",
									{ className: "wbsum-badge" },
									isTeam ? h(MemberStack, { plugin: it.plugin, members: it.members }) : null,
									market === true ? h("span", { className: "wbsum-badge-market" }, t("marketBadge")) : null,
									isTeam ? teamLabel : pickText(it.category),
								),
							),
							it.summary ? h("div", { className: "wbsum-desc" }, it.summary) : null,
						),
					);
				};

				/* 市场列表体内联三态 + 已连接的四种子态（载入 / 空 / 结果 / 加载更多）。
				   注意：这里不渲染官方分类下拉与目录列表 —— 市场是另一条数据源。 */
				const marketListBody = () => {
					if (mState === "idle" || mState === "loading") {
						return h(
							"div",
							{ className: "wbsum-note" },
							h("span", { className: "wbsum-dots" }, "···"),
							" ",
							t("marketLoading"),
						);
					}
					if (mState === "unavailable") return h("div", { className: "wbsum-note" }, t("marketUnavailable"));
					if (mState === "error") return h("div", { className: "wbsum-note" }, t("marketStatusFailed"));
					if (!mConnected) {
						return h(MarketConnectCard, {
							t,
							busy: mBusy,
							error: mConnError,
							hint: mHint,
							token: mToken,
							onCapture: doCapture,
							onTokenChange: setMToken,
							onTokenSubmit: doTokenSubmit,
						});
					}
					return [
						mLoading && mItems.length === 0
							? h(
									"div",
									{ className: "wbsum-note", key: "market-loading" },
									h("span", { className: "wbsum-dots" }, "···"),
									" ",
									t("marketLoading"),
								)
							: null,
						!mLoading && mItems.length === 0
							? h("div", { className: "wbsum-note", key: "market-empty" }, t("marketEmpty"))
							: null,
						...mItems.map((it) => renderItem(it, true)),
						mItems.length > 0
							? h(
									"div",
									{ className: "wbsum-market-more-row", key: "market-more" },
									marketHasMore
										? h(
												"button",
												{
													className: "wbsum-market-btn",
													type: "button",
													disabled: mMore || mLoading,
													onClick: doLoadMore,
												},
												mMore ? t("marketLoading") : t("marketLoadMore"),
											)
										: h(
												"span",
												{ className: "wbsum-market-all" },
												`${t("marketAllLoaded")}${mTotal > 0 ? ` · ${mTotal}${t("countSuffix")}` : ""}`,
											),
								)
							: null,
					];
				};

				return h(
					"div",
					{
						ref: boxRef,
						className: "wbsum-panel",
						style: { left: pos?.left ?? 12, bottom: pos?.bottom ?? 12, maxHeight: pos?.maxHeight },
						role: "dialog",
						"aria-label": t("title"),
						/* 注意：这里刻意不写 aria-modal —— pocket 客户端有一条
						   [aria-modal="true"]{max-width:calc(100vw-32px)!important}，会把整屏面板
						   压窄 32px。返回手势改由本组件的 history 控制器自己处理（见 usePanelBack）。 */
						"data-state": phase,
					},
					h(
						"div",
						{ className: "wbsum-head" },
						h("input", {
							ref: inputRef,
							className: "wbsum-search",
							value: q,
							placeholder: kind === "market" ? t("marketSearch") : t("search"),
							onChange: (e) => setQ(e.target.value),
						}),
						/* H5 整屏后的唯一关闭键（桌面隐藏）。面板盖住整屏，点外面关不掉。 */
						h("button", {
							className: "wbsum-close",
							type: "button",
							"aria-label": t("close"),
							title: t("close"),
							onClick: onClose,
						}, "×"),
						h(
							"div",
							{ className: "wbsum-tabrow" },
							h(
								"div",
								{
									className: "wbsum-tabs",
									role: "tablist",
									onKeyDown: onTabKey,
								},
								TAB_ORDER.map((k) =>
									h(
										"button",
										{
											key: k,
											className: "wbsum-tab",
											role: "tab",
											"data-kind": k,
											"aria-selected": String(kind === k),
											onClick: () => setKind(k),
										},
										t(TAB_LABEL[k]),
									),
								),
							),
							/* 分类下拉：市场用市场的分类（带数量），目录用目录的 —— 两边互不串。
							   market tab 里官方分类下拉必须消失（数据源不同，留着只会误导）。 */
							kind === "market"
								? mConnected && mCats.length > 0
									? h(
											"select",
											{
												className: "wbsum-select wbsum-market-select",
												"aria-label": t("allCats"),
												value: mCategory,
												onChange: (e) => setMCategory(e.target.value),
											},
											h("option", { value: "" }, t("allCats")),
											mCats.map((c) =>
												h(
													"option",
													{ key: String(c.id), value: String(c.id) },
													Number(c.count) > 0 ? `${c.name} ${c.count}` : String(c.name ?? c.id),
												),
											),
										)
									: null
								: cats.length > 0
									? h(
										"select",
										{
											className: "wbsum-select",
											value: category,
											onChange: (e) => setCategory(e.target.value),
										},
										h("option", { value: "" }, t("allCats")),
										cats.map((c) => h("option", { key: c.id, value: c.id }, `${c.name} ${c.count}`)),
									)
									: null,
						),
					),
					current !== null && current !== undefined
						? h(
								"div",
								{ className: "wbsum-cur" },
								h(Avatar, { plugin: current.plugin, name: current.title ?? current.name, src: current.avatarUrl }),
								h("span", { className: "wbsum-curname" }, `✓ ${current.title ?? current.name ?? current.plugin}`),
								h(
									"button",
									{ className: "wbsum-act", disabled: busy, onClick: doClear },
									t("unsummon"),
								),
							)
						: null,
					/* 目录错误只在 team/expert 显示；市场错误自己一条，互不串味。 */
					error !== null && kind !== "market" ? h("div", { className: "wbsum-err", role: "alert" }, error) : null,
					mError !== null && kind === "market" ? h("div", { className: "wbsum-err", role: "alert" }, mError) : null,
					h(
						"div",
						{
							className: "wbsum-list",
							onKeyDown: listKeyHandler,
							/* key 随查询维度变 → 换内容时重挂一次，播 140ms 淡入，
							   遮住「旧列表被替换」那一帧；切 tab/搜索都走这条路。 */
							key: kind === "market" ? `market|${debounced}|${mCategory}` : `${kind}|${debounced}|${category}`,
						},
						kind === "market"
							? marketListBody()
							: sessionId === undefined
								? h("div", { className: "wbsum-note" }, t("noSession"))
								: data === null && error === null
									? h("div", { className: "wbsum-note" }, h("span", { className: "wbsum-dots" }, "···"), " ", t("loading"))
									: visible.length === 0
										? h("div", { className: "wbsum-note" }, t("empty"))
										: visible.map((it) => renderItem(it, false)),
					),
					h(
						"div",
						{ className: "wbsum-foot" },
						kind === "market"
							? mConnected && mState === "ready"
								? h("span", null, `${mItems.length}/${mTotal}${t("countSuffix")}`)
								: null
							: data !== null
								? h("span", null, `${data.total}${t("countSuffix")}${data.degraded ? ` · ${t("offline")}` : ""}`)
								: null,
						h("span", { style: { marginLeft: "auto" } }, kind === "market" ? t("marketFootHint") : t("footHint")),
					),
				);
			}

			/* ───────────────────── 入口按钮 ───────────────────── */
			function SummonEntry(props) {
				const sessionId = props.sessionId ?? props.session?.id;
				// phase: closed → open →（关闭时）closing → closed；closing 期间播退场动效
				const [phase, setPhase] = React.useState("closed");
				const [current, setCurrent] = React.useState(null);
				const [pos, setPos] = React.useState(null);
				const btnRef = React.useRef(null);
				const closeTimer = React.useRef(null);				const t = typeof props.t === "function" ? props.t : (k) => k;

				const refresh = React.useCallback(() => {
					apiStatus(sessionId)
						.then((d) => {
							const s = d.summon;
							setCurrent(s === null || s === undefined ? null : { ...s, name: s.name ?? s.plugin });
						})
						.catch(() => {
							/* host 未就绪时保持原状 */
						});
				}, [sessionId]);

				// 轮询只在面板打开时跑（打开即手动刷一次），关闭即停，不再常驻 5s
				React.useEffect(() => {
					if (phase === "closed") return undefined;
					refresh();
					const timer = setInterval(refresh, 4000);
					return () => clearInterval(timer);
				}, [phase, refresh]);

				React.useEffect(() => () => clearTimeout(closeTimer.current), []);

				// 窄屏整屏后「点面板外面关闭」够不到，Android 返回/侧滑会直接退应用。
				// 打开时压一条历史项，popstate 关面板；从 UI（关闭键 / 召唤按钮）关闭时用
				// history.back() 把这条历史消耗掉，栈里不留半成品。只在 ≤1023 生效，
				// 宽屏完全不动宿主的历史栈。
				const histRef = React.useRef(false);
				const pushBackEntry = () => {
					if (typeof window === "undefined" || !window.matchMedia("(max-width:1023px)").matches) return;
					if (histRef.current) return;
					try { history.pushState({ wbsum: "panel" }, ""); histRef.current = true; } catch (e) {}
				};
				const dropBackEntry = () => {
					if (!histRef.current) return;
					histRef.current = false;
					try { history.back(); } catch (e) {}
				};
				React.useEffect(() => {
					const onPop = () => {
						if (!histRef.current) return;
						histRef.current = false;
						clearTimeout(closeTimer.current);
						setPhase("closing");
						closeTimer.current = setTimeout(() => setPhase("closed"), 130);
					};
					window.addEventListener("popstate", onPop);
					return () => window.removeEventListener("popstate", onPop);
				}, []);

				const openPanel = () => {
					clearTimeout(closeTimer.current);
					if (btnRef.current !== null) {
						const r = btnRef.current.getBoundingClientRect();
						const GAP = 8;
						const EDGE = 8;
						// 向上展开：面板**底边**贴住按钮上沿（bottom 锚定，不猜内容高度），
						// 能用的竖直空间交给 max-height，内容再长也只在下沿往上的范围内滚。
						setPos({
							left: Math.max(EDGE, Math.min(r.left, window.innerWidth - 404)),
							bottom: Math.max(EDGE, window.innerHeight - r.top + GAP),
							maxHeight: Math.min(560, Math.max(160, r.top - GAP - EDGE)),
						});
					}
					setPhase("open");
					pushBackEntry();
				};
				const closePanel = () => {
					if (phase !== "open") return;
					dropBackEntry();
					setPhase("closing");
					closeTimer.current = setTimeout(() => setPhase("closed"), 130);
				};
				const toggle = () => (phase === "open" ? closePanel() : openPanel());

				const label = current === null ? t("btn") : current.title ?? current.name ?? current.plugin;
				return h(
					React.Fragment,
					null,
					h(
						"button",
						{
							ref: btnRef,
							className: "wbsum-btn",
							"data-active": current === null ? "0" : "1",
							"aria-expanded": String(phase === "open"),
							title: current === null ? t("btnHint") : `${t("current")}：${label}`,
							onClick: toggle,
							type: "button",
						},
						current === null
							? h("span", null, "✦")
							: h(Avatar, { small: true, plugin: current.plugin, name: current.title ?? current.name, src: current.avatarUrl }),
						h("span", null, label),
						h("span", { className: "wbsum-caret" }, "▾"),
					),
					phase !== "closed"
						? ReactDOM.createPortal(
								h(SummonPanel, {
									sessionId,
									current,
									pos,
									t,
									phase,
									onClose: closePanel,
									onChanged: (r) =>
										setCurrent(r === null ? null : { ...r, title: r?.title ?? r?.name ?? r?.plugin }),
								}),
								document.body,
							)
						: null,
				);
			}

			/* ───────────────────── 文案 ───────────────────── */
			const STRINGS = {
				zh: {
					btn: "召唤",
					btnHint: "召唤 WorkBuddy 专家 / 专家团进本会话",
					title: "召唤专家",
					close: "关闭",
					search: "搜索专家、职业、能力关键词…",
					tabTeam: "专家团",
					tabExpert: "专家",
					tabMarket: "市场",
					allCats: "全部分类",
					loading: "载入目录…",
					empty: "没有匹配的条目",
					unsummon: "取消召唤",
					current: "已召唤",
					teamTag: "团",
					noSession: "本会话还没有 id，发一条消息后再召唤。",
					countSuffix: " 条",
					offline: "离线副本",
					footHint: "召唤只作用于当前会话",
					/* ── 市场 ── */
					marketBadge: "市场",
					marketSearch: "搜索 28k+ 在线市场专家…",
					marketLoading: "载入市场…",
					marketDisconnected: "未连接在线市场",
					marketDisconnectedHint:
						"在线市场有 28,000+ 个专家，需要 WorkBuddy 的登录态。让 WorkBuddy 带着调试端口启动后点「连接市场」，也可以手动粘贴 token。",
					marketConnect: "连接市场",
					marketConnecting: "连接中…",
					marketManualToken: "手动粘贴 token",
					marketTokenPlaceholder: "粘贴 WorkBuddy 的 Bearer token",
					marketSubmitToken: "提交",
					marketEmpty: "没有匹配的市场专家",
					marketLoadMore: "加载更多",
					marketAllLoaded: "已全部加载",
					marketUnavailable: "当前宿主不支持在线市场（需要 dsh-workbuddy-summon 0.3.0+）。升级并重启后可用。",
					marketStatusFailed: "市场状态获取失败",
					marketFootHint: "市场专家召唤时按需下载",
				},
				en: {
					btn: "Summon",
					btnHint: "Summon a WorkBuddy expert or expert team into this session",
					title: "Summon expert",
					close: "Close",
					search: "Search experts, roles, capabilities…",
					tabTeam: "Teams",
					tabExpert: "Experts",
					tabMarket: "Market",
					allCats: "All categories",
					loading: "Loading catalog…",
					empty: "No matches",
					unsummon: "Unsummon",
					current: "Summoned",
					teamTag: "Team",
					noSession: "This session has no id yet; send a message first.",
					countSuffix: " items",
					offline: "offline copy",
					footHint: "Summoning applies to this session only",
					/* ── market ── */
					marketBadge: "Market",
					marketSearch: "Search 28k+ market experts…",
					marketLoading: "Loading market…",
					marketDisconnected: "Online market not connected",
					marketDisconnectedHint:
						"The online market has 28,000+ experts and needs your WorkBuddy login. Start WorkBuddy with the debug port, then press Connect; you can also paste a token manually.",
					marketConnect: "Connect",
					marketConnecting: "Connecting…",
					marketManualToken: "Paste token manually",
					marketTokenPlaceholder: "Paste the WorkBuddy Bearer token",
					marketSubmitToken: "Submit",
					marketEmpty: "No matching market experts",
					marketLoadMore: "Load more",
					marketAllLoaded: "All loaded",
					marketUnavailable: "This host does not support the online market (needs dsh-workbuddy-summon 0.3.0+). Upgrade and restart to enable it.",
					marketStatusFailed: "Failed to read market status",
					marketFootHint: "Market experts download on summon",
				},
			};

			function apply(ctx) {
				installStyle();
				// 词典注册放进 effect：热重载时替换而不是撞 namespace。
				// 真实签名是 register(ns, lang, dict)，各自返回 disposer。
				ctx.effect(() => {
					const offZh = ctx.locale.register(NS, "zh", STRINGS.zh);
					const offEn = ctx.locale.register(NS, "en", STRINGS.en);
					return () => {
						if (typeof offZh === "function") offZh();
						if (typeof offEn === "function") offEn();
					};
				}, "dsh-workbuddy-summon: dictionaries");
				const t = ctx.locale.bind(NS);
				try {
					ctx.slots.inject("conversation.input.right", () =>
						ctx.slots.register(
							{
								name: "conversation.input.right",
								id: "dsh-workbuddy-summon",
								order: 40,
								label: () => t("title"),
								inject: () => ({ t }),
							},
							SummonEntry,
						),
					);
					console.log("[dsh-workbuddy-summon] client half mounted on conversation.input.right");
				} catch (error) {
					console.error("[dsh-workbuddy-summon] slot inject failed", error);
				}
			}

			exports.name = "dsh-workbuddy-summon";
			exports.inject = ["slots", "locale"];
			exports.apply = apply;
			return module.exports;
		},
	});
}
