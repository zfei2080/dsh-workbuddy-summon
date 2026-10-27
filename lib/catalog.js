/**
 * WorkBuddy 专家目录（0.2.0）—— 口径与 WorkBuddy 专家中心**完全一致**。
 *
 * 数据源（自动降级，任一环节失败都不影响插件）：
 *   1) 在线 COS 三份公开清单（expert_center + internalExpert + externalExpert，合并去重 448 条）
 *   2) WorkBuddy 本机专家中心快照 ~/.workbuddy/app/cache/experts/manifest.json
 *      —— 这是「WorkBuddy 现在展示什么」的权威副本（含它自己的可见性过滤）；
 *      在线清单不比它新时以它为准（App 刷新过就会自动跟上）。
 *   3) 本插件缓存 ~/.dsh/workbuddy-summon/cache/manifests/
 *   4) 本机镜像 ~/Documents/deepseek/wb-resources/expert-market/（若存在）
 *
 * 0.1.1 的 bug：把本机 marketplaces 里已下载的专家包也当成目录条目，导致目录
 * 457 条 ≠ WorkBuddy 448 条（多出 9 条重复项/团队 lead/非专家）。0.2.0 起本机包
 * **只作为包体内容兜底**（loadPackage 读取），不再进目录。
 *
 * 去重：以 `id` 为主键（WorkBuddy manifest 的 448 个 id 唯一）。
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { localPackEntries, localPackRoots } from "./locals.js";

export const COS_BASE =
	"https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace";
/** 三份同构清单，客户端本身就是叠加使用（公共 + 内部作用域 + 外部作用域）。 */
export const MANIFESTS = ["expert_center.json", "internalExpert.json", "externalExpert.json"];
/** WorkBuddy 桌面端的专家中心缓存（manifest + 元数据）。 */
export const APP_CACHE_DIR = join(homedir(), ".workbuddy", "app", "cache", "experts");
export const APP_MANIFEST = join(APP_CACHE_DIR, "manifest.json");
/** 本机镜像根（若存在则作为离线兜底源）。 */
export const MIRROR_ROOT = join(homedir(), "Documents/deepseek/wb-resources/expert-market");
export const STATE_ROOT = join(homedir(), ".dsh/workbuddy-summon");
export const CACHE_ROOT = join(STATE_ROOT, "cache");

const log = (msg, err) =>
	console[err ? "warn" : "log"](`[dsh-workbuddy-summon] ${msg}${err ? `: ${err?.message ?? err}` : ""}`);

function local(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function writeIfChanged(path, text) {
	if (local(path) === text) return false;
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
	return true;
}

function parseJsonSafe(text) {
	if (typeof text !== "string") return undefined;
	try {
		return JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

function mtimeMs(path) {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

async function httpText(url, timeoutMs) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "*/*" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.text();
	} finally {
		clearTimeout(timer);
	}
}

/* ────────────────────────────── 清单 ────────────────────────────── */

/** 单份清单解析后的中间形态（三份清单 + 本机快照共用）。 */
function manifestChunk(parsed, name, origin) {
	const list = Array.isArray(parsed?.experts) ? parsed.experts : [];
	const categories = Array.isArray(parsed?.categories) ? parsed.categories : [];
	return {
		name,
		origin,
		experts: list,
		categories,
		lastUpdated: typeof parsed?.lastUpdated === "string" ? parsed.lastUpdated : "",
		version: parsed?.version,
		statistics: parsed?.statistics,
	};
}

/** WorkBuddy 桌面端的专家中心快照；不存在或损坏时返回 undefined。 */
function readAppSnapshot() {
	const text = local(APP_MANIFEST);
	if (text === undefined) return undefined;
	const parsed = parseJsonSafe(text);
	if (parsed === undefined || !Array.isArray(parsed.experts)) return undefined;
	const meta = parseJsonSafe(local(join(APP_CACHE_DIR, "metadata.json")) ?? "");
	const chunk = manifestChunk(parsed, "workbuddy-app-cache", "local");
	return {
		...chunk,
		cachedAt: typeof meta?.cachedAt === "string" ? meta.cachedAt : "",
		mtimeMs: mtimeMs(APP_MANIFEST),
	};
}

/** 清单新鲜度：优先内容里的 lastUpdated，退而用文件 mtime。 */
function freshnessOf(chunk) {
	if (chunk === undefined) return 0;
	const parsed = Date.parse(chunk.lastUpdated ?? "");
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	return chunk.mtimeMs ?? 0;
}

/**
 * 收集三份清单：online=true 时先联网，失败逐份降级到缓存 / 镜像。
 * @returns {Promise<{chunks: object[], sources: object[], degraded: boolean}>}
 */
async function collectManifests(opts = {}) {
	const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 12_000;
	const online = opts.online !== false;
	const sources = [];
	const chunks = [];
	let degraded = false;

	for (const name of MANIFESTS) {
		const cachedPath = join(CACHE_ROOT, "manifests", name);
		const mirrorPath = join(MIRROR_ROOT, name);
		let text;
		let origin;
		if (online) {
			try {
				text = await httpText(`${COS_BASE}/${name}`, timeoutMs);
				origin = "cos";
				writeIfChanged(cachedPath, text);
			} catch (error) {
				log(`${name} 在线拉取失败，改用本地副本`, error);
			}
		}
		if (text === undefined) {
			text = local(cachedPath);
			origin = "cache";
			if (text === undefined) {
				text = local(mirrorPath);
				origin = "mirror";
			}
			if (text !== undefined) degraded = true;
		}
		if (text === undefined) {
			sources.push({ name, origin: "unavailable", count: 0 });
			continue;
		}
		const parsed = parseJsonSafe(text);
		if (parsed === undefined) {
			log(`${name} 解析失败（来自 ${origin}）`);
			sources.push({ name, origin: "bad-json", count: 0 });
			continue;
		}
		const chunk = manifestChunk(parsed, name, origin);
		chunks.push(chunk);
		sources.push({
			name,
			origin,
			count: chunk.experts.length,
			version: chunk.version,
			lastUpdated: chunk.lastUpdated,
		});
	}
	return { chunks, sources, degraded };
}

/** 分类名表：id → { id, name }（name 取中文，与 WorkBuddy 卡片一致）。 */
function buildCategoryMap(chunks) {
	const map = new Map();
	for (const chunk of chunks) {
		for (const c of chunk.categories) {
			if (typeof c?.id !== "string" || map.has(c.id)) continue;
			map.set(c.id, { id: c.id, name: zh(c.name) || c.id });
		}
	}
	return map;
}

/**
 * 合并多份清单并按 id 去重。
 * 先到的条目优先（WorkBuddy 的叠加顺序即 base → internal → external）。
 */
function mergeChunks(chunks, categoryMap) {
	const seen = new Map();
	for (const chunk of chunks) {
		for (const raw of chunk.experts) {
			const id = typeof raw?.id === "string" ? raw.id : undefined;
			const key = id ?? `${raw?.plugin ?? ""}::${raw?.id ?? ""}`;
			if (seen.has(key)) continue;
			const categoryName =
				raw.categoryName !== undefined ? raw.categoryName : categoryMap.get(raw.categoryId)?.name;
			seen.set(key, {
				...raw,
				...(categoryName === undefined ? {} : { categoryName }),
				_manifest: chunk.name,
			});
		}
	}
	const entries = [...seen.values()];
	const categories = [];
	const used = new Set();
	// 先按清单 categories 的顺序（= WorkBuddy 专家中心的分类顺序）输出，再补漏。
	for (const [id, c] of categoryMap) {
		if (!entries.some((e) => e.categoryId === id)) continue;
		used.add(id);
		categories.push(c);
	}
	for (const e of entries) {
		if (e.categoryId === undefined || used.has(e.categoryId)) continue;
		used.add(e.categoryId);
		categories.push({
			id: e.categoryId,
			name: categoryMap.get(e.categoryId)?.name ?? zh(e.categoryName) ?? e.categoryId,
		});
	}
	return { entries, categories };
}

/**
 * 拉取（或复用缓存/本机快照）专家目录。
 * @param {{fresh?: boolean, timeoutMs?: number}} opts
 * @returns {Promise<{entries: object[], categories: object[], sources: object[], degraded: boolean,
 *   fetchedAt: string, parity: object}>}
 */
export async function loadCatalog(opts = {}) {
	const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 12_000;
	const appSnap = readAppSnapshot();
	const remote = await collectManifests({ online: opts.fresh !== false, timeoutMs });

	// 选源：本机快照不旧于在线清单时以快照为准（= WorkBuddy 现在展示的），否则用在线清单。
	const appFresh = freshnessOf(appSnap);
	const remoteFresh = remote.chunks.length
		? Math.max(...remote.chunks.map((c) => freshnessOf(c)))
		: 0;
	const useApp = appSnap !== undefined && (remote.chunks.length === 0 || appFresh >= remoteFresh);
	const chunks = useApp ? [appSnap] : remote.chunks;

	const categoryMap = buildCategoryMap(chunks);
	const { entries: officialEntries, categories } = mergeChunks(chunks, categoryMap);

	// 内置固化包：永远合并（不依赖 WorkBuddy / 网络），排在官方条目之前。
	const packs = opts.includeLocalPacks === false ? [] : localPackEntries();
	const entries = [...packs, ...officialEntries];

	const sources = [...remote.sources];
	if (packs.length > 0) {
		sources.unshift({ name: "local-packs", origin: "bundled", count: packs.length });
	}
	if (appSnap !== undefined) {
		sources.unshift({
			name: "workbuddy-app-cache",
			origin: "local",
			count: appSnap.experts.length,
			lastUpdated: appSnap.lastUpdated,
			cachedAt: appSnap.cachedAt,
			chosen: useApp,
		});
	}

	const parity = computeParity(entries, appSnap);
	if (parity.missingFromCatalog.length > 0 || parity.extraInCatalog.length > 0) {
		log(
			`目录与 WorkBuddy 快照有差异：缺 ${parity.missingFromCatalog.length} 条、多 ${parity.extraInCatalog.length} 条`,
		);
	}

	return {
		entries,
		categories,
		sources,
		degraded: remote.degraded && !useApp,
		fetchedAt: new Date().toISOString(),
		parity,
	};
}

/** 目录 vs WorkBuddy 快照的差异（id 维度），供自检与测试使用。 */
function computeParity(entries, appSnap) {
	// 内置固化包是插件自带资源，不参与「与 WorkBuddy 一致」的口径。
	const official = entries.filter((e) => e._manifest !== "local-pack");
	const catalogIds = new Set(official.map((e) => e.id));
	const appIds = new Set((appSnap?.experts ?? []).map((e) => e.id));
	return {
		appCache: appSnap
			? {
					count: appSnap.experts.length,
					lastUpdated: appSnap.lastUpdated,
					cachedAt: appSnap.cachedAt,
				}
			: null,
		catalogCount: official.length,
		bundledPacks: entries.length - official.length,
		missingFromCatalog: [...appIds].filter((id) => !catalogIds.has(id)),
		extraInCatalog: [...catalogIds].filter((id) => !appIds.has(id)),
	};
}

/* ──────────────────────── 本机包（只做内容兜底） ──────────────────────── */

/**
 * 本机包目录注册表：plugin → 该包在 ~/.workbuddy 下的真实目录。
 * 这些包**不再**进目录条目（0.1.1 在这里多出 9 条噪音），只用于 loadPackage 取正文。
 */
const LOCAL_ROOTS = new Map();
let localScanCache = null;
const LOCAL_SCAN_TTL_MS = 60_000;

function scanLocalMarketplaces() {
	if (localScanCache !== null && Date.now() - localScanCache.at < LOCAL_SCAN_TTL_MS) {
		return localScanCache.entries;
	}
	const out = collectLocalMarketplacePackages();
	localScanCache = { at: Date.now(), entries: out };
	return out;
}

function ensureLocalScanned() {
	// 内置固化包（packs/）优先登记：它们在插件目录里，永远可读，不依赖 WorkBuddy。
	for (const [plugin, root] of localPackRoots()) {
		if (!LOCAL_ROOTS.has(plugin)) LOCAL_ROOTS.set(plugin, root);
	}
	scanLocalMarketplaces();
}

function collectLocalMarketplacePackages() {
	const base = join(homedir(), ".workbuddy/plugins/marketplaces");
	const out = [];
	let markets;
	try {
		markets = readdirSync(base);
	} catch {
		return out;
	}
	for (const market of markets) {
		const pluginsDir = join(base, market, "plugins");
		let dirs;
		try {
			dirs = readdirSync(pluginsDir);
		} catch {
			continue;
		}
		for (const dir of dirs) {
			const root = join(pluginsDir, dir);
			const manifestText =
				local(join(root, ".codebuddy-plugin/plugin.json")) ??
				local(join(root, ".workbuddy-plugin/plugin.json"));
			if (manifestText === undefined) continue;
			const d = parseJsonSafe(manifestText);
			if (d === undefined) continue;
			// 只登记目录（给 pkgFile 兜底用）；是否专家由目录清单决定，不在这里造条目
			LOCAL_ROOTS.set(d.name ?? dir, root);
			if (d.expertType === "agent" || d.expertType === "team") {
				out.push({ plugin: d.name ?? dir, expertType: d.expertType, root });
			}
		}
	}
	return out;
}

/** 本机已下载专家包的索引（仅诊断用，不参与目录）。 */
export function localMarketplaceEntries() {
	return scanLocalMarketplaces();
}

/** 某个 plugin 若在本机市场里有实体目录，返回它的路径；否则 undefined。 */
export function localRootOf(plugin) {
	ensureLocalScanned();
	return LOCAL_ROOTS.get(plugin);
}

/* ────────────────────────────── 包体 ────────────────────────────── */

const PKG_CACHE = join(CACHE_ROOT, "packages");

function pkgCacheFile(plugin, rel) {
	return join(PKG_CACHE, plugin, rel);
}
function pkgMirrorFile(plugin, rel) {
	return join(MIRROR_ROOT, "remote", plugin, rel);
}

/**
 * 2026-06 之后进市场的包不再出现在公开 COS 的 `plugins/<p>/` 下，
 * 正文只能从官方无签名回退源 `<COS_BASE>/bundles/<plugin>.tar.gz` 取。
 * 取回整包解开写缓存，用 `.bundle-fetched` 标记幂等。
 */
async function fetchBundle(plugin, opts = {}) {
	const mark = join(PKG_CACHE, plugin, ".bundle-fetched");
	if (local(mark) !== undefined) return true;
	const url = `${COS_BASE}/bundles/${plugin}.tar.gz`;
	let buf;
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
		try {
			const res = await fetch(url, { signal: ctrl.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			buf = Buffer.from(await res.arrayBuffer());
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		log(`${plugin} bundle 拉取失败`, error);
		return false;
	}
	const dest = join(PKG_CACHE, plugin);
	try {
		mkdirSync(dest, { recursive: true });
		const tgz = join(dest, ".bundle.tar.gz");
		writeFileSync(tgz, buf);
		// Electron 的 node 没有内置 tar，用系统 tar（各目标平台都自带）
		execFileSync("tar", ["-xzf", tgz, "-C", dest], { stdio: "ignore", timeout: 120_000 });
		rmSync(tgz, { force: true });
		writeFileSync(mark, new Date().toISOString());
		return true;
	} catch (error) {
		log(`${plugin} bundle 解包失败`, error);
		return false;
	}
}

/**
 * 取一个包里的单个文本文件：本机包目录 → 缓存 → 镜像 → 在线逐文件 → 在线整包。
 * @param {{optional?: boolean}} [fileOpts] optional=true 时 404 属正常（README/settings）
 * @returns {Promise<string | undefined>}
 */
async function pkgFile(plugin, rel, opts = {}, fileOpts = {}) {
	const localRoot =
		typeof opts.localRoot === "string" && opts.localRoot.length > 0
			? opts.localRoot
			: LOCAL_ROOTS.get(plugin);
	if (localRoot !== undefined) {
		const own = local(join(localRoot, rel));
		if (own !== undefined) return own;
	}
	const cache = pkgCacheFile(plugin, rel);
	if (opts.offlineOnly !== true) {
		const hit = local(cache);
		if (hit !== undefined) return hit;
		const mirror = local(pkgMirrorFile(plugin, rel));
		if (mirror !== undefined) {
			writeIfChanged(cache, mirror);
			return mirror;
		}
		// 路径①：老包的逐文件公开源
		try {
			const text = await httpText(`${COS_BASE}/plugins/${plugin}/${rel}`, opts.timeoutMs ?? 12_000);
			writeIfChanged(cache, text);
			return text;
		} catch {
			/* 交给 loadPackage 决定要不要走整包兜底 */
		}
		if (opts.noBundle !== true && (await fetchBundle(plugin, opts))) {
			const fromBundle = local(cache);
			if (fromBundle !== undefined) return fromBundle;
		}
		if (fileOpts.optional !== true) log(`${plugin}/${rel} 拉取失败（两条路径都没有）`);
		return undefined;
	}
	return local(cache) ?? local(pkgMirrorFile(plugin, rel));
}

/**
 * 加载一个专家包的完整内容（plugin.json + settings.json + agents/*.md + skills）。
 * 部分包的 `agents` 字段是目录或 null，此时成员名从 teamInfo / members 推导。
 */
export async function loadPackage(plugin, opts = {}) {
	if (typeof plugin !== "string" || plugin.length === 0 || plugin.includes("..")) return undefined;
	ensureLocalScanned();
	let manifestText = await pkgFile(plugin, ".codebuddy-plugin/plugin.json", opts, { optional: true });
	if (parseJsonSafe(manifestText) === undefined && opts.offlineOnly !== true && opts.noBundle !== true) {
		if (await fetchBundle(plugin, opts)) {
			manifestText = await pkgFile(
				plugin,
				".codebuddy-plugin/plugin.json",
				{ ...opts, noBundle: true },
				{ optional: true },
			);
		}
	}
	const manifest = parseJsonSafe(manifestText);
	const inner = { ...opts, noBundle: true };
	const settings = parseJsonSafe(await pkgFile(plugin, "settings.json", inner, { optional: true }));

	const declared = Array.isArray(manifest?.agents) ? manifest.agents : [];
	const names = new Set();
	for (const rel of declared) {
		const s = String(rel);
		if (s.endsWith(".md")) names.add(s.split("/").pop().replace(/\.md$/, ""));
	}
	if (names.size === 0 || declared.some((s) => String(s).replace(/\/$/, "").endsWith("agents"))) {
		const info = manifest?.teamInfo ?? {};
		if (info.leadAgent) names.add(info.leadAgent);
		for (const m of info.memberAgents ?? []) names.add(m);
		for (const m of manifest?.members ?? []) if (m?.id) names.add(m.id);
	}
	// 本地已有但清单没写全的成员也收进来
	for (const dir of [
		join(PKG_CACHE, plugin, "agents"),
		join(MIRROR_ROOT, "remote", plugin, "agents"),
	]) {
		try {
			for (const f of readdirSync(dir)) if (f.endsWith(".md")) names.add(f.replace(/\.md$/, ""));
		} catch {
			/* 目录不存在 */
		}
	}

	const agents = {};
	for (const name of names) {
		if (name === undefined || name === null) continue;
		const text = await pkgFile(plugin, `agents/${name}.md`, inner);
		if (text !== undefined) agents[String(name)] = text;
	}

	const skills = [];
	for (const rel of manifest?.skills ?? []) {
		const dir = String(rel).replace(/^\.\//, "").replace(/^\/+/, "");
		const text = await pkgFile(plugin, `${dir}/SKILL.md`, inner);
		if (text !== undefined) {
			skills.push({
				path: dir,
				name: dir.split("/").pop(),
				text,
				description: frontmatterField(text, "description"),
				references: referenceIndex(text),
			});
		}
	}

	return {
		plugin,
		manifest,
		manifestText,
		settings,
		agents,
		agentNames: Object.keys(agents),
		skills,
		readme: await pkgFile(plugin, "README.md", inner, { optional: true }),
	};
}

/** 取技能里的单个 reference 文件（渐进式披露的第二层）。 */
export async function loadSkillReference(plugin, skillDir, ref, opts = {}) {
	const clean = String(ref ?? "").replace(/^\/+/, "");
	if (clean.includes("..") || !clean.endsWith(".md")) return undefined;
	const rel = clean.startsWith("references/") ? clean : `references/${clean}`;
	return pkgFile(plugin, `${String(skillDir).replace(/\/+$/, "")}/${rel}`, opts, { optional: true });
}

/** 从技能正文里提取 references 清单。 */
export function referenceIndex(skillText, limit = 80) {
	if (typeof skillText !== "string") return [];
	const out = [];
	const seen = new Set();
	for (const m of skillText.matchAll(/references\/([A-Za-z0-9_./-]+\.md)/g)) {
		const rel = `references/${m[1]}`;
		if (seen.has(rel)) continue;
		seen.add(rel);
		out.push(rel);
		if (out.length >= limit) break;
	}
	return out;
}

/** 从 markdown frontmatter 里取一个标量字段。 */
export function frontmatterField(text, field) {
	const fm = parseYamlFrontmatter(text);
	const value = fm?.[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 解析 agent / skill md 的 frontmatter。 */
export function parseFrontmatter(text) {
	return parseYamlFrontmatter(text);
}

/**
 * YAML 子集解析器 —— 只覆盖 WorkBuddy 专家包 frontmatter 实际用到的形态：
 *   key: value / key: |（块标量）/ 两层嵌套映射 / 内联 [a, b] / `- item` 列表。
 */
export function parseYamlFrontmatter(text) {
	if (typeof text !== "string") return {};
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m) return {};
	const lines = m[1].split(/\r?\n/);
	const out = {};

	const strip = (v) => v.trim().replace(/^["']|["']$/g, "");
	const inlineList = (v) => {
		const inner = v.slice(1, -1).trim();
		if (inner.length === 0) return [];
		return inner
			.split(",")
			.map((p) => strip(p))
			.filter((p) => p.length > 0);
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.trim().length === 0 || /^\s*#/.test(line)) continue;
		const kv = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
		if (kv === null) continue;
		const key = kv[1];
		const rest = kv[2];

		// 块标量：|  | -  >  > -
		if (/^\s*[|>][-+]?\s*$/.test(rest)) {
			const fold = rest.trim().startsWith(">");
			const block = [];
			while (i + 1 < lines.length) {
				const next = lines[i + 1];
				if (next !== undefined && (/^\s+\S/.test(next) || next.trim().length === 0)) {
					block.push(next.replace(/^\s{1,6}/, ""));
					i += 1;
				} else break;
			}
			out[key] = fold
				? block.join(" ").replace(/\s+/g, " ").trim()
				: block.join("\n").replace(/\s+$/, "");
			continue;
		}

		if (rest.trim().length > 0) {
			const v = rest.trim();
			out[key] = v.startsWith("[") && v.endsWith("]") ? inlineList(v) : strip(v);
			continue;
		}

		const child = {};
		const list = [];
		let consumed = 0;
		while (i + 1 < lines.length) {
			const next = lines[i + 1];
			if (!/^\s+\S/.test(next)) break;
			const ckv = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(next);
			if (ckv !== null) {
				child[ckv[1]] = strip(ckv[2]);
			} else {
				const item = /^\s+-\s+(.*)$/.exec(next);
				if (item !== null) list.push(strip(item[1]));
				else break;
			}
			i += 1;
			consumed += 1;
		}
		if (consumed === 0) out[key] = "";
		else out[key] = list.length > 0 && Object.keys(child).length === 0 ? list : child;
	}
	return out;
}

/* ────────────────────────────── 条目视图 ────────────────────────────── */

const zh = (v) => (v && typeof v === "object" ? (v.zh ?? v.en) : v) ?? "";

/** 把清单条目压成给 UI / 工具用的轻量视图（不含正文）。 */
export function entryView(e) {
	const members = (e.members ?? []).map((m) => ({
		id: m.id,
		name: zh(m.name ?? m.displayName),
		profession: zh(m.profession),
		role: m.role ?? "member",
		avatar: m.avatar ?? null,
	}));
	return {
		id: e.id,
		plugin: e.plugin,
		kind: e.kind ?? "expert",
		expertType: e.expertType ?? "agent",
		// WorkBuddy 卡片主标题是 profession（如「中文网络小说创作顾问」），副标题是花名。
		title: zh(e.profession) || zh(e.displayName) || e.plugin,
		name: zh(e.displayName),
		nameEn: (e.displayName && typeof e.displayName === "object" ? e.displayName.en : e.displayName) ?? "",
		profession: zh(e.profession),
		description: zh(e.description),
		categoryId: e.categoryId,
		category: zh(e.categoryName) || e.categoryId,
		tags: (e.tags ?? []).map(zh),
		promptFile: e.promptFile,
		agentName: e.agentName,
		lead: members.find((m) => m.role === "lead")?.id ?? e.agentName,
		members: members.filter((m) => m.role !== "lead"),
		initPrompt: zh(e.defaultInitPrompt),
		isOPC: Boolean(e.isOPC),
		manifest: e._manifest,
		sourceId: e.sourceId,
		// 在线市场条目：expertId 用于下载包体；版本用于缓存失效。
		marketExpertId: typeof e.marketExpertId === "string" ? e.marketExpertId : undefined,
		marketVersion: typeof e.marketVersion === "string" ? e.marketVersion : undefined,
		useCount: Number.isFinite(Number(e.useCount)) ? Number(e.useCount) : undefined,
		// 头像原始路径：/avatars/<Id>.png、/plugins/<pkg>/avatars/x.png 或本机包相对路径
		avatar: e.avatar ?? null,
		// UI 与工具共用同一轻量形状：summary 是截断后的简介，memberCount 不含主理人
		memberCount: members.filter((m) => m.role !== "lead").length,
		summary: oneLine(zh(e.description), 140),
	};
}

/** 压成一行并截断（响应体与注入段都靠它控制体积）。 */
export function oneLine(text, max) {
	const flat = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export { zh };
