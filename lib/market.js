/**
 * WorkBuddy 在线专家市场（0.3.0）。
 *
 * 官方专家中心（COS 清单，448 条）之外，WorkBuddy 还有一条**登录态**的在线市场：
 *   · 搜索：POST /v2/operation-platform/market/expert/list（28k+ 条，按关键词/分类分页）
 *   · 详情：POST /v2/operation-platform/market/expert/get-by-ids
 *   · 下载：POST /v2/operation-platform/market/expert/download-url → 签名 zip
 *   · 分类：POST /v2/operation-platform/market/expert-categories
 *
 * 鉴权只需要一个 Bearer token（JWT）。token 拿取的唯一可靠途径是 WorkBuddy 自己：
 * 以 `--remote-debugging-port=9222` 启动后，渲染进程里 `window.wb.account.token()` 能直接取到；
 * 顺带 `window.wb.experts.*` 也暴露了同一套市场能力（本模块只用它兜底）。
 *
 * 设计约束：
 *   · token 只落本机 `~/.dsh/workbuddy-summon/market-token.json`，绝不写日志；
 *   · 市场条目不进离线目录（28k 条太大），只在面板「市场」tab 里按需在线查询；
 *   · 召唤市场专家 = 下载签名 zip → 解包到插件缓存 → 用 loadPackage 读正文。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { STATE_ROOT, CACHE_ROOT, zh } from "./catalog.js";

export const MARKET_ORIGIN = "https://www.workbuddy.cn";
export const MARKET_API = {
	list: "/v2/operation-platform/market/expert/list",
	byIds: "/v2/operation-platform/market/expert/get-by-ids",
	downloadUrl: "/v2/operation-platform/market/expert/download-url",
	categories: "/v2/operation-platform/market/expert-categories",
};

const TOKEN_FILE = join(STATE_ROOT, "market-token.json");
const CATEGORIES_FILE = join(CACHE_ROOT, "market-categories.json");
const PKG_ROOT = join(CACHE_ROOT, "market-packages");

const log = (...a) => console.log("[dsh-workbuddy-summon:market]", ...a);

/* ───────────────────────────── token ───────────────────────────── */

function parseJwt(token) {
	try {
		const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
		return payload && typeof payload === "object" ? payload : undefined;
	} catch {
		return undefined;
	}
}

/** 读取本地 token；过期/损坏返回 undefined。 */
export function readToken() {
	let text;
	try {
		text = readFileSync(TOKEN_FILE, "utf8");
	} catch {
		return undefined;
	}
	let record;
	try {
		record = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof record?.token !== "string" || record.token.length < 20) return undefined;
	const payload = parseJwt(record.token);
	const exp = Number(payload?.exp);
	if (Number.isFinite(exp) && exp * 1000 < Date.now()) return undefined;
	return {
		token: record.token,
		uid: typeof record.uid === "string" ? record.uid : (payload?.sub ?? ""),
		exp: Number.isFinite(exp) ? exp : undefined,
		capturedAt: typeof record.capturedAt === "string" ? record.capturedAt : undefined,
	};
}

function writeTokenRecord(token, uid, extra = {}) {
	mkdirSync(STATE_ROOT, { recursive: true });
	const payload = parseJwt(token);
	const record = {
		token,
		uid: uid || payload?.sub || "",
		exp: Number.isFinite(Number(payload?.exp)) ? Number(payload.exp) : undefined,
		capturedAt: new Date().toISOString(),
		...extra,
	};
	writeFileSync(TOKEN_FILE, JSON.stringify(record), { mode: 0o600 });
	return record;
}

export function clearToken() {
	try {
		rmSync(TOKEN_FILE, { force: true });
		return true;
	} catch {
		return false;
	}
}

/** 手动粘贴 token：先校验格式与过期时间，再跑一次分类接口验证可用性。 */
export async function saveToken(rawToken) {
	const token = String(rawToken ?? "").trim().replace(/^Bearer\s+/i, "");
	if (token.length < 20) throw Object.assign(new Error("token 太短，格式不对"), { code: "bad-token" });
	const payload = parseJwt(token);
	if (payload === undefined) throw Object.assign(new Error("token 不是合法的 JWT"), { code: "bad-token" });
	if (Number(payload.exp) * 1000 < Date.now()) {
		throw Object.assign(new Error("token 已过期，请重新抓取"), { code: "token-expired" });
	}
	writeTokenRecord(token, payload.sub, {});
	try {
		const categories = await marketCategories({ token: readToken() });
		return { ...readToken(), categories };
	} catch (error) {
		clearToken();
		throw error;
	}
}

/* ───────────────────────── CDP token 抓取 ───────────────────────── */

async function cdpTargets(port, timeoutMs) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const list = await res.json();
		return list.filter((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
	} finally {
		clearTimeout(timer);
	}
}

function cdpConnect(wsUrl, timeoutMs) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		let id = 0;
		const pending = new Map();
		const timer = setTimeout(() => {
			try { ws.close(); } catch {}
			reject(new Error("CDP 连接超时"));
		}, timeoutMs);
		ws.onopen = () => {
			clearTimeout(timer);
			resolve({
				send(method, params = {}) {
					return new Promise((r, j) => {
						const mid = ++id;
						pending.set(mid, { r, j });
						ws.send(JSON.stringify({ id: mid, method, params }));
					});
				},
				close() {
					try { ws.close(); } catch {}
				},
			});
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error("CDP WebSocket 连接失败"));
		};
		ws.onmessage = (ev) => {
			let msg;
			try {
				msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
			} catch {
				return;
			}
			if (msg.id !== undefined && pending.has(msg.id)) {
				const { r, j } = pending.get(msg.id);
				pending.delete(msg.id);
				if (msg.error) j(new Error(JSON.stringify(msg.error)));
				else r(msg.result);
			}
		};
	});
}

/**
 * 通过 WorkBuddy 的调试端口抓一次 token。
 * 前置：WorkBuddy 以 `--remote-debugging-port=<port>` 启动，且已登录。
 * @returns {Promise<{token:string, uid:string, exp?:number}|undefined>}
 */
export async function captureTokenFromWorkBuddy(opts = {}) {
	const port = Number.isFinite(opts.port) ? opts.port : 9222;
	const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000;
	let targets;
	try {
		targets = await cdpTargets(port, timeoutMs);
	} catch (error) {
		throw Object.assign(
			new Error(
				`连不上 WorkBuddy 调试端口 127.0.0.1:${port}（${error.message}）。` +
					`请先关闭 WorkBuddy，再用 "E:\\workbuddy\\WorkBuddy.exe" --remote-debugging-port=${port} 启动它，并保持登录。`,
			),
			{ code: "cdp-unavailable" },
		);
	}
	if (targets.length === 0) {
		throw Object.assign(new Error("调试端口已连上，但没有找到 WorkBuddy 页面"), { code: "no-target" });
	}
	let lastError;
	for (const target of targets) {
		let cdp;
		try {
			cdp = await cdpConnect(target.webSocketDebuggerUrl, timeoutMs);
			const result = await cdp.send("Runtime.evaluate", {
				expression: `(async () => {
					const token = await window.wb?.account?.token?.();
					if (!token) return null;
					let uid = "";
					try {
						const u = window.wb.account.uid;
						uid = typeof u === "function" ? (u() || "") : (u || "");
					} catch {}
					if (typeof uid !== "string") uid = "";
					return { token, uid };
				})()`,
				awaitPromise: true,
				returnByValue: true,
			});
			const value = result?.result?.value;
			if (value && typeof value.token === "string" && value.token.length > 20) {
				const record = writeTokenRecord(value.token, value.uid);
				log(`token 抓取成功：uid=${record.uid} exp=${record.exp ?? "-"}`);
				return record;
			}
			lastError = new Error("页面里没有拿到 token（可能未登录）");
		} catch (error) {
			lastError = error;
		} finally {
			cdp?.close();
		}
	}
	throw Object.assign(lastError ?? new Error("抓取 token 失败"), { code: "capture-failed" });
}

/* ───────────────────────────── 市场 API ───────────────────────────── */

async function marketFetch(path, body, token, opts = {}) {
	const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 15_000;
	const method = opts.method === "GET" ? "GET" : "POST";
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(`${MARKET_ORIGIN}${path}`, {
			method,
			signal: ctrl.signal,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token.token}`,
				"X-User-Id": token.uid || "",
				"X-Domain": "www.workbuddy.cn",
			},
			...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
		});
		const text = await res.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		if (res.status === 401 || res.status === 403) {
			throw Object.assign(new Error("市场 token 已失效，需要重新抓取"), { code: "token-invalid" });
		}
		if (!res.ok) throw Object.assign(new Error(`市场 API HTTP ${res.status}`), { code: "http-error" });
		if (json === undefined) throw Object.assign(new Error("市场 API 返回非 JSON"), { code: "bad-json" });
		if (json.code !== 0) throw Object.assign(new Error(json.msg || `市场 API code=${json.code}`), { code: "api-error" });
		return json.data ?? {};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 搜索市场专家。
 * @returns {Promise<{total:number, items:object[]}>} items 为归一化后的目录条目
 */
export async function marketSearch(params = {}) {
	const token = params.token ?? readToken();
	if (token === undefined) throw Object.assign(new Error("尚未连接在线市场（没有 token）"), { code: "no-token" });
	const body = {
		page: Math.max(1, Number(params.page) || 1),
		page_size: Math.min(100, Math.max(1, Number(params.pageSize) || 30)),
		sort_by: "reco_rank",
		sort_order: "desc",
	};
	if (params.q) body.keyword = String(params.q).slice(0, 80);
	if (Array.isArray(params.categories) && params.categories.length > 0) body.categories = params.categories;
	const data = await marketFetch(MARKET_API.list, body, token);
	const items = Array.isArray(data.experts) ? data.experts : [];
	return {
		total: Number(data.total_count ?? items.length),
		items: items.map(marketItemToEntry),
		page: body.page,
		pageSize: body.page_size,
	};
}

/** 市场分类（带数量）。 */
export async function marketCategories(params = {}) {
	const token = params.token ?? readToken();
	if (token === undefined) throw Object.assign(new Error("尚未连接在线市场（没有 token）"), { code: "no-token" });
	const data = await marketFetch(MARKET_API.categories, undefined, token, { method: "GET" });
	const raw = Array.isArray(data.items) ? data.items : [];
	const items = raw
		.map((c) => ({
			id: c.id,
			// 真实接口是扁平字段 name_zh/name_en；兼容 CDP 侧返回的 {zh,en} 形状。
			name: zh(c.name) || c.name_zh || c.name_en || c.id,
			count: Number(c.expertCount ?? c.item_count ?? c.expert_count ?? 0),
			order: Number(c.order ?? c.sort_order ?? 0),
		}))
		.sort((a, b) => a.order - b.order);
	try {
		mkdirSync(join(CATEGORIES_FILE, ".."), { recursive: true });
		writeFileSync(CATEGORIES_FILE, JSON.stringify({ at: new Date().toISOString(), items }, null, 1));
	} catch {
		/* 缓存失败不影响主流程 */
	}
	return items;
}

/** 缓存里的分类（离线展示用）。 */
export function cachedCategories() {
	try {
		const parsed = JSON.parse(readFileSync(CATEGORIES_FILE, "utf8"));
		return Array.isArray(parsed?.items) ? parsed.items : [];
	} catch {
		return [];
	}
}

/** 按 expert id 批量取详情。 */
export async function marketGetByIds(ids, params = {}) {
	const token = params.token ?? readToken();
	if (token === undefined) throw Object.assign(new Error("尚未连接在线市场（没有 token）"), { code: "no-token" });
	const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === "string" && x.length > 0).slice(0, 50);
	if (list.length === 0) return [];
	const data = await marketFetch(MARKET_API.byIds, { expert_ids: list }, token);
	const items = Array.isArray(data.experts) ? data.experts : [];
	return items.map(marketItemToEntry);
}

/** 取签名下载地址。 */
export async function marketDownloadUrl(expertId, params = {}) {
	const token = params.token ?? readToken();
	if (token === undefined) throw Object.assign(new Error("尚未连接在线市场（没有 token）"), { code: "no-token" });
	const data = await marketFetch(MARKET_API.downloadUrl, { expert_id: String(expertId) }, token);
	const url = data.download_url ?? data.downloadUrl ?? data.url;
	if (typeof url !== "string" || !/^https:\/\//.test(url)) {
		throw Object.assign(new Error("下载地址为空或非法"), { code: "bad-url" });
	}
	return url;
}

/* ───────────────────────── 包体下载与解包 ───────────────────────── */

function findPackageRoot(dir) {
	const candidates = [];
	const walk = (base, depth = 0) => {
		if (depth > 3) return;
		const manifest = join(base, ".codebuddy-plugin", "plugin.json");
		if (existsSync(manifest)) {
			candidates.push(base);
			return;
		}
		let entries = [];
		try {
			entries = readdirSync(base, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) if (e.isDirectory()) walk(join(base, e.name), depth + 1);
	};
	walk(dir);
	return candidates[0];
}

/**
 * 确保某个市场专家的包体已解包到本地缓存，返回可给 loadPackage 用的本地根目录。
 * @param {{expertId:string, plugin:string, version?:string}} params
 * @returns {Promise<{root:string, plugin:string, version?:string}>}
 */
export async function ensureMarketPackage(params = {}) {
	const expertId = String(params.expertId ?? "").trim();
	const plugin = String(params.plugin ?? "").trim();
	if (expertId.length === 0 || plugin.length === 0) {
		throw Object.assign(new Error("ensureMarketPackage 需要 expertId 与 plugin"), { code: "bad-args" });
	}
	const version = String(params.version ?? "").replace(/[^\w.\-]/g, "");
	const dirName = `${plugin}@${expertId}${version ? `@${version}` : ""}`.replace(/[^\w.@\-]/g, "_");
	const dest = join(PKG_ROOT, dirName);
	const marker = join(dest, ".extracted");
	if (existsSync(marker)) {
		const root = findPackageRoot(dest);
		if (root !== undefined) return { root, plugin, version };
	}
	const url = await marketDownloadUrl(expertId, params);
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 120_000);
	let buf;
	try {
		const res = await fetch(url, { signal: ctrl.signal });
		if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
		buf = Buffer.from(await res.arrayBuffer());
	} finally {
		clearTimeout(timer);
	}
	if (buf.length < 200) throw Object.assign(new Error("下载到的包体异常（过小）"), { code: "bad-package" });
	mkdirSync(dest, { recursive: true });
	const zipPath = join(dest, ".package.zip");
	writeFileSync(zipPath, buf);
	try {
		execFileSync("tar", ["-xf", zipPath, "-C", dest], { stdio: "ignore", timeout: 120_000 });
	} catch (error) {
		throw Object.assign(new Error(`解包失败：${error?.message ?? error}`), { code: "extract-failed" });
	} finally {
		rmSync(zipPath, { force: true });
	}
	const root = findPackageRoot(dest);
	if (root === undefined) throw Object.assign(new Error("包内没有 .codebuddy-plugin/plugin.json"), { code: "bad-package" });
	writeFileSync(marker, new Date().toISOString());
	return { root, plugin, version };
}

/* ───────────────────────────── 条目归一 ───────────────────────────── */

/**
 * 市场条目 → 目录条目（与 lib/catalog.js entryView 兼容）。
 * 注意：avatar 是绝对 URL（openplatform-cdn），由头像代理层处理。
 */
export function marketItemToEntry(item) {
	const tags = [];
	const tagsZh = Array.isArray(item.tags_zh) ? item.tags_zh : [];
	const tagsEn = Array.isArray(item.tags_en) ? item.tags_en : [];
	for (let i = 0; i < Math.max(tagsZh.length, tagsEn.length); i += 1) {
		tags.push({ zh: tagsZh[i] ?? tagsEn[i] ?? "", en: tagsEn[i] ?? tagsZh[i] ?? "" });
	}
	const categories = Array.isArray(item.categories) ? item.categories : [];
	const detail = Array.isArray(item.categories_detail) ? item.categories_detail : [];
	return {
		id: item.source_id ?? item.expert_id,
		plugin: item.plugin_name ?? item.plugin ?? item.plugin_id,
		expertType: item.expert_type === "team" ? "team" : "agent",
		displayName: { zh: item.display_name_zh ?? item.expert_id, en: item.display_name_en ?? "" },
		profession: { zh: item.profession_zh ?? "", en: item.profession_en ?? "" },
		description: { zh: item.description_zh ?? "", en: item.description_en ?? "" },
		avatar: typeof item.icon === "string" ? item.icon : undefined,
		tags,
		quickPrompts: Array.isArray(item.quick_prompts) ? item.quick_prompts : [],
		defaultInitPrompt: item.default_init_prompt ?? { zh: "", en: "" },
		agentName: item.agent_name,
		categoryId: categories[0],
		categoryName: detail[0]?.name_zh,
		useCount: Number.isFinite(Number(item.use_count)) ? Number(item.use_count) : 0,
		_manifest: "market",
		marketExpertId: item.expert_id,
		marketVersion: item.version ?? item.plugin_version,
	};
}

/** 市场条目是否可用（最小校验）。 */
export function isMarketEntry(entry) {
	return typeof entry?.marketExpertId === "string" && entry.marketExpertId.length > 0;
}

export const MARKET_PKG_ROOT = PKG_ROOT;
