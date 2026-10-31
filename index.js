/**
 * dsh-workbuddy-summon — Host 半边（0.5.0）
 *
 * 把 WorkBuddy 的「专家 / 专家团」做成在线目录 + 对话框召唤，目录口径与 WorkBuddy
 * 专家中心逐条一致（本机专家中心快照优先，其次 COS 在线清单，再退插件缓存 / 本机镜像；
 * 任一层失败只降级不抛错）：
 *   · **未召唤的会话一个字都不注入**（求值器返回空串，宿主 renderPrompt 过滤）；
 *   · 召唤时异步取包 → 预计算注入文本 → 落盘；求值器只同步查表
 *     （求值器每个模型步都跑，里面绝不能有网络或磁盘扫描）；
 *   · 成员正文按需取（wb_expert_read），不整团预注入，避免一个 6 人团吃掉几万 token。
 *
 * 0.5.0 加的三条纪律（都是宿主今天拦不住、只能靠模型自觉的地方，见 lib/dispatch.js）：
 *   · **一个会话只跑一个任务键**（order×plugin×round）：异键拒绝，同键算续做，
 *     轮次+1 也拒绝（返工逐轮换新实例，必须开新会话）；
 *   · **派发不由模型拼提示词**：wb_expert_dispatch 自己读定义原文、自己拼 prompt、
 *     算身份指纹并登记；模型只负责把返回的 prompt 原样交给 spawn_teammate；
 *   · **派完能核对**：wb_expert_verify 读宿主真实登记的子代理目录认 wb: 标记。
 *     核不到就如实报核不到 —— 读不到 ≠ 通过。
 *
 * 依赖服务：systemPrompt（注入段）、tools（模型侧工具）、webServer（UI 路由）、
 * agents（拿当前发起 Agent → sessionId）。
 * 可选服务：subagents（回读子代理目录做派发核对）—— 用 ctx.get 惰性取，
 * 拿不到就降级成「核对不了」，不让插件因为宿主没装它而挂载失败。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import {
	loadCatalog,
	loadPackage,
	loadSkillReference,
	entryView,
	COS_BASE,
	STATE_ROOT,
	zh,
} from "./lib/catalog.js";
import {
	getSummon,
	setSummon,
	clearSummon,
	listSummons,
	sessionIdOf,
	pruneSummons,
} from "./lib/state.js";
import { composeSummon, turnWarning, SECTION_NAME, SECTION_ORDER } from "./lib/inject.js";
import {
	makeTaskKey,
	parseTaskKey,
	fingerprint,
	shortToken,
	recordDispatch,
	getDispatch,
	listDispatches,
	markVerified,
	markMismatch,
	revokeDispatches,
	bumpTurns,
	resetTurns,
	pruneDispatches,
	DEFAULT_TURN_BUDGET,
} from "./lib/dispatch.js";
import { getAvatar, avatarUrl, marketAvatarUrl, getAvatarBySrc, AVATAR_DEFAULT_SIZE } from "./lib/avatars.js";
import {
	readToken,
	saveToken,
	captureTokenFromWorkBuddy,
	marketSearch,
	marketCategories,
	cachedCategories,
	marketGetByIds,
	ensureMarketPackage,
} from "./lib/market.js";
import { installShims, checkShimDeps } from "./lib/shims.js";

export const name = "dsh-workbuddy-summon";
export const inject = ["systemPrompt", "tools", "webServer", "agents"];

const ROUTE = "/dsh-workbuddy-summon";
const SECTIONS_DIR = join(STATE_ROOT, "sections");
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SUMMON_SESSIONS = 200;
/**
 * 头像缓存策略：短 max-age + 内容 ETag。
 * 不能像静态资源那样 cache 一天 —— 那会让 WorkBuddy 换头像后最长一天看不到新图，
 * 而"跟着他的数据动"正是这个插件的立身之本。
 */
const AVATAR_CACHE_CONTROL = "public, max-age=300";

const log = (...a) => console.log("[dsh-workbuddy-summon]", ...a);

/* ─────────────────────────── 目录缓存（进程内） ─────────────────────────── */

let catalogCache = null; // { at, entries(byPlugin), views, sources, degraded }

function indexCatalog(result) {
	const byPlugin = new Map();
	const views = [];
	for (const raw of result.entries) {
		const view = entryView(raw);
		if (view.plugin !== undefined && !byPlugin.has(view.plugin)) byPlugin.set(view.plugin, raw);
		views.push(view);
	}
	// 同一 plugin 的多个条目（不同 id）都保留，供按 id 精确召唤
	const byKey = new Map();
	for (const raw of result.entries) byKey.set(`${raw.plugin}::${raw.id}`, raw);
	return {
		at: Date.now(),
		byPlugin,
		byKey,
		views,
		categories: result.categories ?? [],
		parity: result.parity ?? null,
		sources: result.sources,
		degraded: result.degraded,
	};
}

async function catalog(opts = {}) {
	const fresh = opts.fresh === true;
	if (!fresh && catalogCache !== null && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
		return catalogCache;
	}
	const result = await loadCatalog({ fresh: fresh || catalogCache === null });
	catalogCache = indexCatalog(result);
	log(
		`目录就绪：${catalogCache.views.length} 条（${
			catalogCache.sources.map((s) => `${s.name}:${s.origin}/${s.count}`).join(" ")
		}）${catalogCache.degraded ? "（降级）" : ""}`,
	);
	return catalogCache;
}

/** 按 plugin 或 plugin::id 找条目。 */
function findEntry(cat, key) {
	if (typeof key !== "string" || key.length === 0) return undefined;
	if (cat.byKey.has(key)) return cat.byKey.get(key);
	return cat.byPlugin.get(key);
}

/* ─────────────────────────── 注入段（预计算 + 落盘） ─────────────────────────── */

/** sessionId → { text, plugin, chars, at } */
const sections = new Map();

function sectionFile(sessionId) {
	return join(SECTIONS_DIR, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}.md`);
}

function loadSectionFromDisk(sessionId) {
	try {
		const text = readFileSync(sectionFile(sessionId), "utf8");
		if (text.length > 0) return text;
	} catch {
		/* 无缓存 */
	}
	return undefined;
}

/**
 * 删掉某会话的注入段落盘文件。
 * 取消召唤时**删文件而不是写空串** —— 写空串会留下 0 字节垃圾，
 * 时间一长 sections/ 里全是这种没有归属的空壳。
 */
function removeSectionFile(sessionId) {
	try {
		rmSync(sectionFile(sessionId), { force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * 回收 sections/ 里的垃圾：0 字节文件 + 已经没有召唤记录的孤儿文件。
 * 启动时跑一次即可（求值器只查内存 Map，这些文件纯粹是磁盘卫生问题）。
 */
function sweepSectionFiles() {
	let files;
	try {
		files = readdirSync(SECTIONS_DIR);
	} catch {
		return 0;
	}
	const aliveNames = new Set(Object.keys(listSummons()).map((id) => basename(sectionFile(id))));
	let removed = 0;
	for (const name of files) {
		if (!name.endsWith(".md")) continue;
		const full = join(SECTIONS_DIR, name);
		try {
			// 0 字节（历史遗留或写入失败）与孤儿（已无召唤记录）都回收
			if (statSync(full).size === 0 || !aliveNames.has(name)) {
				rmSync(full, { force: true });
				removed += 1;
			}
		} catch {
			/* 单个文件出错不影响其余 */
		}
	}
	return removed;
}

/**
 * 取包并预计算注入文本；写盘 + 记进召唤状态。
 * @returns {Promise<{chars: number, truncated: boolean}>}
 */
async function buildSection(sessionId, entry, pkg, cfg) {
	const text = composeSummon(entry, pkg, {
		sessionId,
		maxLeadChars: Number.isFinite(cfg?.maxLeadChars) ? cfg.maxLeadChars : 24_000,
		taskKey: cfg?.taskKey,
		continuation: cfg?.continuation,
		turnBudget: Number.isFinite(cfg?.turnBudget) ? cfg.turnBudget : DEFAULT_TURN_BUDGET,
	});
	if (text.length === 0) {
		// 组装不出内容（例如包本体取不到）：删掉落盘而不是写空串，避免留 0 字节垃圾
		sections.delete(sessionId);
		removeSectionFile(sessionId);
		return { chars: 0, truncated: false };
	}
	mkdirSync(SECTIONS_DIR, { recursive: true });
	writeFileSync(sectionFile(sessionId), text);
	sections.set(sessionId, {
		text,
		plugin: pkg.plugin,
		chars: text.length,
		at: new Date().toISOString(),
	});
	const lead = pkg.agentNames?.[0];
	return {
		chars: text.length,
		truncated: (pkg.agents?.[lead]?.length ?? 0) > 24_000,
	};
}

/** 从条目取包体：市场专家走「下载签名 zip → 解包缓存」，官方专家走原有 COS/本机链路。 */
async function packageFor(entry) {
	const plugin = entry.plugin;
	if (typeof plugin !== "string" || plugin.length === 0) {
		throw Object.assign(new Error(`条目 "${entry.id ?? ""}" 缺少 plugin 字段`), { code: "bad-entry" });
	}
	if (typeof entry.marketExpertId === "string" && entry.marketExpertId.length > 0) {
		const info = await ensureMarketPackage({
			expertId: entry.marketExpertId,
			plugin,
			version: entry.marketVersion,
		});
		return await loadPackage(plugin, { localRoot: info.root, offlineOnly: true, noBundle: true });
	}
	return await loadPackage(plugin, {});
}

/** 召唤一个专家/专家团进某会话（支持在线市场专家）。 */
async function summon(opts) {
	const { sessionId, key, marketExpertId } = opts;
	const marketId = typeof marketExpertId === "string" ? marketExpertId.trim() : "";
	let entry;
	if (marketId.length > 0) {
		const hits = await marketGetByIds([marketId]);
		entry = hits[0];
		if (entry === undefined) {
			throw Object.assign(new Error(`在线市场里找不到专家 "${marketId}"`), { code: "not-found" });
		}
	} else {
		const cat = await catalog({ fresh: opts.fresh === true });
		entry = findEntry(cat, key);
		if (entry === undefined) {
			const avail = cat.views.slice(0, 12).map((v) => v.plugin).join(", ");
			throw Object.assign(new Error(`未找到专家包 "${key}"（目录共 ${cat.views.length} 条，例如：${avail}…）`), {
				code: "not-found",
			});
		}
	}
	const plugin = entry.plugin;
	if (typeof plugin !== "string" || plugin.length === 0) {
		throw Object.assign(new Error(`条目 "${key}" 缺少 plugin 字段`), { code: "bad-entry" });
	}
	const kind = (entry.expertType ?? "agent") === "team" ? "team" : "expert";
	const isMarket = typeof entry.marketExpertId === "string" && entry.marketExpertId.length > 0;

	// ── 一事一会话的闸 ──
	// 任务键 = order（哪件事）× role（哪个专家）× round（第几轮）。
	// 同键 ⇒ 续做，放行并计数；异键 ⇒ 拒绝，必须开新会话。
	// 升级前留下的记录没有 taskKey，不拦（否则会把用户正在用的会话锁死），接管后补上键。
	const taskKey = makeTaskKey({ order: opts.order, role: plugin, round: opts.round });
	const existing = getSummon(sessionId);
	let continuation = 0;
	if (existing !== undefined && typeof existing.taskKey === "string" && existing.taskKey !== taskKey) {
		const prev = parseTaskKey(existing.taskKey);
		const next = parseTaskKey(taskKey);
		const sameJobNewRound = prev !== undefined && next !== undefined
			&& prev.order === next.order && prev.role === next.role && next.round > prev.round;
		throw Object.assign(
			new Error(
				`本会话已经在跑「${existing.title ?? existing.plugin}」（任务 ${prev?.order ?? "?"} · 第 ${prev?.round ?? "?"} 轮），` +
					`不能再换成「${entryView(entry).title}」（任务 ${next?.order ?? "?"} · 第 ${next?.round ?? "?"} 轮）。` +
					`一个会话只跑一件事：请开一个新会话再召唤。` +
					(sameJobNewRound
						? `若这是同一件事的返工换轮次，也必须换新会话——逐轮换新实例，别让上一轮的评审人验自己改过的东西。`
						: `若确实要在本会话换人，先 wb_unsummon（会丢掉当前专家身份，会话历史保留），但那样两个任务的上下文会混在一起，不推荐。`),
			),
			{ code: "session-busy", existing: existing.taskKey, incoming: taskKey },
		);
	}
	if (existing !== undefined) continuation = (existing.continuations ?? 0) + 1;

	const pkg = await packageFor(entry);
	if (pkg === undefined || pkg.manifest === undefined) {
		throw Object.assign(
			new Error(
				`专家包 "${plugin}" 的定义取不到（该包可能走登录态分发，COS 上 404）。` +
					`可在 WorkBuddy 里召唤一次让它落到本机镜像后重试。`,
			),
			{ code: "package-unavailable" },
		);
	}
	// 先算注入段（buildSection 会把文本放进内存 sections，注入即刻生效），
	// 再一次性写召唤状态 —— 避免出现「状态说已召唤、注入段还没就绪」的窗口。
	const built = await buildSection(sessionId, entry, pkg, { ...opts.config, taskKey, continuation });
	const view = entryView(entry);
	const avatar = isMarket
		? marketAvatarUrl(entry.avatar)
		: view.avatar === null || view.avatar === undefined
			? null
			: avatarUrl(view.plugin);
	setSummon(sessionId, {
		plugin,
		kind,
		entryId: entry.id,
		...(isMarket ? { marketExpertId: entry.marketExpertId } : {}),
		title: view.title,
		alias: view.name,
		avatarUrl: avatar,
		pkgAgents: pkg.agentNames?.length ?? 0,
		pkgSkills: pkg.skills?.length ?? 0,
		chars: built.chars,
		truncated: built.truncated,
		taskKey,
		order: parseTaskKey(taskKey)?.order ?? "-",
		round: parseTaskKey(taskKey)?.round ?? 1,
		continuations: continuation,
	});
	// 续做时轮次预算接着算，不清零；新任务从 0 开始
	if (continuation === 0) resetTurns(sessionId);
	return {
		sessionId,
		plugin,
		kind,
		marketExpertId: isMarket ? entry.marketExpertId : undefined,
		title: view.title,
		name: view.name,
		profession: view.profession,
		avatarUrl: avatar,
		members: view.members.map((m) => m.id),
		skills: (pkg.skills ?? []).map((s) => s.name),
		taskKey,
		continuation,
		...(continuation > 0
			? { note: `本会话第 ${continuation + 1} 次召唤同一任务键，按「续做」处理：起点＝工作区现状与前任留下的文件，**不许重做已完成的部分**，也不要另起新会话。` }
			: {}),
		...built,
	};
}

/** 取消召唤（清注入 + 清状态 + 撤销派发登记）。 */
function unsummon(sessionId) {
	sections.delete(sessionId);
	removeSectionFile(sessionId);
	revokeDispatches(sessionId);
	resetTurns(sessionId);
	return clearSummon(sessionId);
}

/* ─────────────────────────── 模型侧工具 ─────────────────────────── */

const jsonRender = (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }];

function currentSessionId(ctx) {
	const agent = ctx.agents?.currentInitiator?.() ?? ctx.agents?.requireInitiator?.();
	return sessionIdOf(agent);
}

function toolList(ctx, cfg) {
	return {
		name: "wb_experts_list",
		description:
			"列出 WorkBuddy 专家 / 专家团在线目录（默认读 6 小时内的进程缓存，不联网）。" +
			"用于在召唤前确认有哪些角色：返回 plugin、名称、类型（team=专家团）、分类、成员数。" +
			"传 refresh:true 强制联网刷新清单。",
		parameters: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["all", "team", "expert"], description: "只看专家团 / 单专家 / 全部，默认 all" },
				category: { type: "string", description: "分类 ID 或中文名子串，如 02-Engineering 或 金融" },
				q: { type: "string", description: "在名称/职业/简介/标签里做子串匹配" },
				limit: { type: "number", description: "最多返回条数，默认 40，上限 200" },
				refresh: { type: "boolean", description: "true = 强制联网刷新清单" },
			},
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const cat = await catalog({ fresh: args?.refresh === true });
			const kind = args?.kind ?? "all";
			const q = typeof args?.q === "string" ? args.q.trim().toLowerCase() : "";
			const category = typeof args?.category === "string" ? args.category.trim().toLowerCase() : "";
			const limit = Math.min(200, Math.max(1, Number.isFinite(args?.limit) ? args.limit : 40));
			let rows = cat.views;
			if (kind === "team") rows = rows.filter((v) => v.expertType === "team");
			else if (kind === "expert") rows = rows.filter((v) => v.expertType !== "team");
			if (category.length > 0) {
				rows = rows.filter(
					(v) =>
						String(v.categoryId ?? "").toLowerCase().includes(category) ||
						String(v.category ?? "").toLowerCase().includes(category),
				);
			}
			if (q.length > 0) {
				rows = rows.filter((v) =>
					`${v.name} ${v.nameEn} ${v.profession} ${v.description} ${v.tags.join(" ")} ${v.plugin}`
						.toLowerCase()
						.includes(q),
				);
			}
			const current = getSummon(currentSessionId(ctx));
			return {
				total: rows.length,
				returned: Math.min(limit, rows.length),
				degraded: cat.degraded,
				sources: cat.sources,
				currentSummon: current ?? null,
				items: rows.slice(0, limit).map((v) => ({
					plugin: v.plugin,
					id: v.id,
					title: v.title,
					name: v.name,
					expertType: v.expertType,
					category: v.category,
					profession: v.profession,
					memberCount: v.memberCount,
					tags: v.tags.slice(0, 4),
					summary: v.summary,
				})),
			};
		},
	};
}

/**
 * 长文本分页：技能正文最大实测 257k 字符（workbuddy 市场 1315 个 SKILL.md 里 167 个 >20k），
 * 绝不能整块塞回模型。默认给 24k 一段，带 nextFrom 让模型自己续读。
 */
function paginate(text, from, maxChars) {
	const start = Math.max(0, Number.isFinite(from) ? Math.floor(from) : 0);
	const cap = Math.max(2000, Number.isFinite(maxChars) ? Math.floor(maxChars) : 24_000);
	const total = typeof text === "string" ? text.length : 0;
	if (total === 0) return { chunk: "", from: 0, nextFrom: null, total: 0, truncated: false };
	const chunk = text.slice(start, start + cap);
	const nextFrom = start + chunk.length < total ? start + chunk.length : null;
	return { chunk, from: start, nextFrom, total, truncated: nextFrom !== null };
}

function toolRead(ctx, cfg) {
	const cap = Number.isFinite(cfg?.maxReadChars) ? cfg.maxReadChars : 24_000;
	return {
		name: "wb_expert_read",
		description:
			"按需取回 WorkBuddy 专家包里的原文，四种用法：" +
			"① 不传 agent/skill → 返回该包清单（成员 Agent ID、技能与其 references 目录）；" +
			"② agent=<Agent ID> → 取成员定义原文（专家团派发成员前必做，把返回的 text 完整放进 spawn_teammate 的 prompt）；" +
			"③ skill=<技能名> → 取技能正文；④ skill=<技能名> + ref=<references/x.md> → 取该技能的分层细节文件。" +
			"长文本按 24k 字符分段返回：nextFrom 非空表示还有后续，带 from=<nextFrom> 续读，不要凭截断内容臆测后半部分。",
		parameters: {
			type: "object",
			properties: {
				plugin: { type: "string", description: "专家包名（来自 wb_experts_list 的 plugin 字段）" },
				agent: { type: "string", description: "成员 Agent ID（团长用清单里的 lead 字段）" },
				skill: { type: "string", description: "技能名（清单 skills 里的 name）" },
				ref: { type: "string", description: "技能内的分层细节文件，形如 references/xxx.md" },
				from: { type: "number", description: "续读起始字符偏移（用上次返回的 nextFrom）" },
				what: { type: "string", enum: ["auto", "readme", "manifest"], description: "auto（默认）；readme / manifest 取包说明与原始元数据" },
			},
			required: ["plugin"],
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const plugin = String(args?.plugin ?? "").trim();
			if (plugin.length === 0) throw new Error("wb_expert_read: 需要 plugin");
			const pkg = await loadPackage(plugin, {});
			if (pkg === undefined || pkg.manifest === undefined) {
				throw new Error(`wb_expert_read: 取不到包 "${plugin}"（该包可能走登录态分发，本机也没有）`);
			}
			if (args?.what === "manifest") return { plugin, manifest: pkg.manifest, settings: pkg.settings ?? null };
			if (args?.what === "readme") {
				const p = paginate(pkg.readme ?? "", args?.from, cap);
				return { plugin, readme: p.chunk, ...pickPage(p), empty: (pkg.readme ?? "").length === 0 };
			}
			if (typeof args?.skill === "string" && args.skill.length > 0) {
				const hit = (pkg.skills ?? []).find((s) => s.name === args.skill || s.path === args.skill);
				if (hit === undefined) {
					return { plugin, error: `无技能 "${args.skill}"`, available: (pkg.skills ?? []).map((s) => s.name) };
				}
				if (typeof args?.ref === "string" && args.ref.length > 0) {
					const text = await loadSkillReference(plugin, hit.path, args.ref, {});
					if (text === undefined) {
						return { plugin, skill: hit.name, error: `取不到 "${args.ref}"`, available: hit.references ?? [] };
					}
					const p = paginate(text, args?.from, cap);
					return { plugin, skill: hit.name, ref: args.ref, text: p.chunk, ...pickPage(p) };
				}
				const p = paginate(hit.text, args?.from, cap);
				return {
					plugin,
					skill: hit.name,
					description: hit.description ?? "",
					text: p.chunk,
					...pickPage(p),
					references: hit.references ?? [],
					hint:
						(hit.references?.length ?? 0) > 0
							? "该技能有分层细节：按需传 ref=<上面的路径> 取用，不要一次性全取。"
							: undefined,
				};
			}
			if (typeof args?.agent === "string" && args.agent.length > 0) {
				const text = pkg.agents?.[args.agent];
				if (text === undefined) {
					return { plugin, error: `无成员 "${args.agent}"`, available: pkg.agentNames ?? [] };
				}
				const p = paginate(text, args?.from, cap);
				return { plugin, agent: args.agent, text: p.chunk, ...pickPage(p) };
			}
			return {
				plugin,
				expertType: pkg.manifest?.expertType ?? "agent",
				lead: pkg.manifest?.agentName ?? pkg.manifest?.teamInfo?.leadAgent ?? null,
				agents: pkg.agentNames ?? [],
				skills: (pkg.skills ?? []).map((s) => ({
					name: s.name,
					description: s.description ?? "",
					references: s.references ?? [],
				})),
				hint: "传 agent=<Agent ID> 取成员定义原文；传 skill=<技能名> 取技能正文，再配 ref=<references/x.md> 取细节。",
			};
		},
	};
}

/** 只把分页元信息摊平进返回值（避免把整段原文重复一份）。 */
function pickPage(p) {
	return { from: p.from, nextFrom: p.nextFrom, totalChars: p.total, truncated: p.truncated };
}

function toolSummon(ctx, cfg) {
	return {
		name: "wb_summon",
		description:
			"把一个 WorkBuddy 专家 / 专家团召唤进**当前会话**（等价于用户在对话框点「召唤」）。" +
			"生效后该角色的身份、工作方法、团队编制与调度规程会注入本会话的系统提示词，" +
			"后续每一轮都保持生效，直到 wb_unsummon 或用户取消。只影响当前会话。" +
			"🔴 一个会话只跑一个任务键（order×plugin×round）：本会话已在跑别的事项或别的专家时会被直接拒绝，" +
			"这时请开新会话，不要就地接着做。同一任务键再召唤一次＝续做，会接着上次的轮次预算。",
		parameters: {
			type: "object",
			properties: {
				plugin: { type: "string", description: "专家包名（wb_experts_list 的 plugin 字段，或 wb_market_search 的 plugin）" },
				marketExpertId: {
					type: "string",
					description: "在线市场专家 ID（wb_market_search 返回的 marketExpertId）；提供时会下载并解包该专家的包体",
				},
				order: { type: "string", description: "事项标识（工单号 / 任务名），用于一事一会话的判定。缺省为未指定" },
				round: { type: "number", description: "轮次，默认 1。同一事项返工换新实例时加 1" },
			},
			required: ["plugin"],
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const sessionId = currentSessionId(ctx);
			if (sessionId === undefined) {
				throw new Error("wb_summon: 取不到当前会话 id（无法定位注入目标）");
			}
			const result = await summon({
				sessionId,
				key: String(args?.plugin ?? "").trim(),
				marketExpertId: typeof args?.marketExpertId === "string" ? args.marketExpertId : undefined,
				order: typeof args?.order === "string" ? args.order : undefined,
				round: Number.isFinite(args?.round) ? args.round : undefined,
				config: cfg,
			});
			return {
				...result,
				note: result.note ?? "注入已生效，从下一轮请求开始按该专家身份工作。",
			};
		},
	};
}

function toolUnsummon(ctx) {
	return {
		name: "wb_unsummon",
		description:
			"取消当前会话的 WorkBuddy 专家召唤，恢复默认助手人格。不传参数即取消当前会话的召唤；" +
			"当前没有召唤时返回 summoned:false。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute() {
			const sessionId = currentSessionId(ctx);
			const before = getSummon(sessionId);
			return { sessionId: sessionId ?? null, summoned: before !== undefined, cleared: unsummon(sessionId) };
		},
	};
}

/* ─────────────────────────── 成员派发与核对 ─────────────────────────── */

/**
 * 成员定义原文的派发上限。超过就**拒绝**，不静默截断 ——
 * 静默截断一份人设，正是「看着像那个专家、其实提示词不是它」的来源。
 */
const MAX_DISPATCH_CHARS = 120_000;

/** 从包清单里取成员的职业名（做 spawn 的 description 用）。 */
function memberProfession(pkg, agentId) {
	const m = (pkg?.manifest?.members ?? []).find((x) => x?.id === agentId);
	return zh(m?.profession) || zh(m?.name) || zh(m?.displayName) || "";
}

/**
 * 读宿主真实登记的子代理目录。
 * 用 ctx.get 而不是写进 inject —— 拿不到就降级，不能让插件因为宿主没装
 * sessionQuery 而挂载失败。返回 undefined 表示「读不到」，与「读到但为空」区分开。
 */
async function readChildren(ctx, sessionId) {
	try {
		const subagents = ctx.get?.("subagents");
		if (typeof subagents?.listChildren !== "function") return undefined;
		const rows = await subagents.listChildren(sessionId);
		return Array.isArray(rows) ? rows : undefined;
	} catch {
		return undefined;
	}
}

function toolDispatch(ctx, cfg) {
	const cap = Number.isFinite(cfg?.maxDispatchChars) ? cfg.maxDispatchChars : MAX_DISPATCH_CHARS;
	return {
		name: "wb_expert_dispatch",
		description:
			"派发一个团队成员前**必须先调它**：插件自己读成员定义原文、自己拼好完整 prompt、" +
			"算出身份指纹并登记这次派发，返回 { name, description, prompt, token, taskKey }。" +
			"拿到后原样调 spawn_teammate(name, description, prompt)——prompt 不得增删一字，" +
			"description 里的 wb: 标记不得删（wb_expert_verify 靠它回读核对）。" +
			"同一个 order+agent+round 只能派一次；返工换新实例就把 round 加 1。" +
			"不要自己拿 wb_expert_read 的结果拼 prompt。",
		parameters: {
			type: "object",
			properties: {
				agent: { type: "string", description: "成员 Agent ID（注入段编制表里的那个 id，不是中文名）" },
				task: {
					type: "string",
					description: "本次任务说明 + 上一阶段产出**原文**。成员看不到本会话上下文，缺什么它就没有什么",
				},
				order: { type: "string", description: "事项标识（工单号 / 任务名）。缺省用本会话任务键的事项段" },
				round: { type: "number", description: "轮次，首轮 1；返工换新实例时加 1" },
			},
			required: ["agent", "task"],
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const sessionId = currentSessionId(ctx);
			if (sessionId === undefined) throw new Error("wb_expert_dispatch: 取不到当前会话 id");
			const agentId = String(args?.agent ?? "").trim();
			if (agentId.length === 0) throw new Error("wb_expert_dispatch: 需要 agent");
			const task = String(args?.task ?? "");
			if (task.trim().length === 0) throw new Error("wb_expert_dispatch: 需要 task（成员看不到本会话上下文）");

			const summon = getSummon(sessionId);
			if (summon === undefined) {
				throw new Error("wb_expert_dispatch: 本会话没有召唤记录，先 wb_summon");
			}
			const pkg = await loadPackage(summon.plugin, {});
			if (pkg?.manifest === undefined) {
				throw new Error(`wb_expert_dispatch: 取不到包 "${summon.plugin}" 的定义`);
			}
			const md = pkg.agents?.[agentId];
			if (md === undefined) {
				throw Object.assign(
					new Error(`wb_expert_dispatch: 包 "${summon.plugin}" 里没有成员 "${agentId}"。可用：${(pkg.agentNames ?? []).join(", ")}`),
					{ code: "not-found" },
				);
			}
			if (md.length > cap) {
				throw Object.assign(
					new Error(
						`wb_expert_dispatch: 成员 "${agentId}" 的定义有 ${md.length} 字符，超过派发上限 ${cap}。` +
							`拒绝截断派发——半份人设会得到一个「看着像、其实不是」的成员。` +
							`请把配置项 maxDispatchChars 调大后重试。`,
					),
					{ code: "too-large" },
				);
			}

			// order 缺省继承本会话任务键的事项段，别让它凭空编一个
			const sessionOrder = parseTaskKey(summon.taskKey ?? "")?.order;
			const order = String(args?.order ?? "").trim() || (sessionOrder !== undefined && sessionOrder !== "-" ? sessionOrder : "");
			const round = Number.isFinite(args?.round) ? Math.max(1, Math.floor(args.round)) : 1;
			const taskKey = makeTaskKey({ order, role: agentId, round });

			const fp = fingerprint({ agent: agentId, md, taskKey });
			const token = shortToken(fp);
			const booked = recordDispatch({
				sessionId,
				taskKey,
				agent: agentId,
				fingerprint: fp,
				promptChars: md.length + task.length,
				label: token,
				order,
				round,
			});
			if (!booked.ok) {
				const prev = parseTaskKey(booked.record.taskKey ?? taskKey);
				throw Object.assign(
					new Error(
						`wb_expert_dispatch: 「${order || "-"} · ${agentId} · 第 ${prev?.round ?? round} 轮」已经派发过了` +
							`（${booked.record.at}，状态 ${booked.record.status}）。一事一专家一轮次只能派一次。` +
							(booked.record.status === "verified"
								? `要它接着做就用 send_message 给那个已在跑的子代理，不要重开一个。`
								: `这是返工要换新实例的话，把 round 传 ${round + 1}。`),
					),
					{ code: "duplicate-dispatch", record: booked.record },
				);
			}

			const profession = memberProfession(pkg, agentId);
			const description = `${profession.length > 0 ? `${profession} · ` : ""}${agentId} [${token}]`;
			const prompt = `${md}\n\n---\n\n# 本次任务（由主理人下发）\n\n${task}\n`;
			return {
				dispatchId: taskKey,
				taskKey,
				name: agentId,
				description,
				prompt,
				token,
				fingerprint: fp,
				definitionChars: md.length,
				promptChars: prompt.length,
				round,
				order: order || "-",
				next: `原样调 spawn_teammate(name="${agentId}", description=<上面的 description>, prompt=<上面的 prompt 整段>)，` +
					`然后调 wb_expert_verify(agent="${agentId}", round=${round}) 核对。`,
			};
		},
	};
}

function toolVerify(ctx, cfg) {
	return {
		name: "wb_expert_verify",
		description:
			"核对成员是不是真的按规程派发出去了：读宿主登记的子代理目录，认 wb_expert_dispatch 发的 wb: 标记。" +
			"认得到 = 这次派发落地了；认不到 = 没按规程走（没 spawn、或 prompt/description 被改过、或自己拼的）。" +
			"宿主没提供子代理目录读取时会如实返回 readable:false，那只代表核对不了，不代表派发成功——不得据此声称已核实。",
		parameters: {
			type: "object",
			properties: {
				agent: { type: "string", description: "成员 Agent ID；省略则核对本会话全部未核实的派发" },
				round: { type: "number", description: "轮次，默认 1" },
				order: { type: "string", description: "事项标识，缺省用本会话任务键的事项段" },
			},
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const sessionId = currentSessionId(ctx);
			if (sessionId === undefined) throw new Error("wb_expert_verify: 取不到当前会话 id");
			const summon = getSummon(sessionId);
			const sessionOrder = parseTaskKey(summon?.taskKey ?? "")?.order;
			const order = String(args?.order ?? "").trim()
				|| (sessionOrder !== undefined && sessionOrder !== "-" ? sessionOrder : "");
			const round = Number.isFinite(args?.round) ? Math.max(1, Math.floor(args.round)) : 1;
			const agentId = typeof args?.agent === "string" && args.agent.trim().length > 0 ? args.agent.trim() : undefined;

			// 指定了 agent 就精确核对那一条 (order, agent, round)；没指定才核对本会话全部待核对的。
			// 🔴 round 必须真参与定位 —— 收了参数却不用来过滤，会把别的轮次一起算进来，
			// 结果是「明明这一轮派对了，却因为另一轮没派而判不通过」。
			let targets;
			if (agentId === undefined) {
				targets = listDispatches(sessionId).filter((d) => d.status === "dispatched" || d.status === "mismatch");
				if (targets.length === 0) {
					return {
						sessionId,
						readable: true,
						verified: false,
						checked: 0,
						reason: "本会话没有待核对的派发。先走 wb_expert_dispatch，不要自己拼 prompt 直接 spawn。",
					};
				}
			} else {
				const key = makeTaskKey({ order, role: agentId, round });
				const hit = getDispatch(sessionId, key);
				if (hit === undefined) {
					const any = listDispatches(sessionId).filter((d) => d.agent === agentId);
					return {
						sessionId,
						agent: agentId,
						taskKey: key,
						verified: false,
						readable: false,
						reason: any.length === 0
							? `没有「${agentId}」的派发登记——先调 wb_expert_dispatch，不要自己拼 prompt 直接 spawn。`
							: `没有「${key}」这一条派发登记。该成员已登记的轮次：${any.map((d) => `r${d.round}(${d.status})`).join(", ")}。`,
					};
				}
				if (hit.status === "verified") {
					return {
						sessionId,
						readable: true,
						verified: true,
						checked: 1,
						passed: 1,
						results: [{
							taskKey: hit.taskKey,
							agent: hit.agent,
							verified: true,
							childId: hit.childId,
							note: `此前已核对通过（${hit.verifiedAt}），直接复用结论。`,
						}],
					};
				}
				if (hit.status === "revoked") {
					return {
						sessionId,
						verified: false,
						readable: false,
						reason: `「${key}」的派发登记已随取消召唤撤销，无法核对。要重新派发请重走 wb_expert_dispatch。`,
					};
				}
				targets = [hit];
			}

			const children = await readChildren(ctx, sessionId);
			if (children === undefined) {
				// 读不到 ≠ 没发生。如实报「核对不了」，别把它算成通过。
				return {
					sessionId,
					verified: false,
					readable: false,
					pending: targets.map((d) => ({ taskKey: d.taskKey, agent: d.agent, token: d.token, at: d.at })),
					reason:
						"宿主未提供子代理目录读取（ctx.subagents.listChildren 不可用），无法回读核对。" +
						"派发意图已登记，但**实际起来的子代理未经核实**——不得据此声称已按规程派发。",
				};
			}

			// label 是唯一能回读到的身份线索（catalog 行只有 id/createdAt/mode/label，不含 prompt）
			const labels = children.map((c) => String(c?.label ?? ""));
			const results = [];
			for (const d of targets) {
				const hits = children.filter((c, i) => labels[i].includes(d.token));
				if (hits.length === 1) {
					markVerified(sessionId, d.taskKey, String(hits[0].id ?? ""));
					results.push({ taskKey: d.taskKey, agent: d.agent, verified: true, childId: String(hits[0].id ?? "") });
				} else if (hits.length > 1) {
					markMismatch(sessionId, d.taskKey, `同一个标记 ${d.token} 认到 ${hits.length} 个子代理`);
					results.push({
						taskKey: d.taskKey,
						agent: d.agent,
						verified: false,
						reason: `同一个派发标记认到 ${hits.length} 个子代理——同一轮次被 spawn 了多次。逐轮只能有一个实例。`,
					});
				} else {
					markMismatch(sessionId, d.taskKey, "宿主目录里认不到该标记");
					results.push({
						taskKey: d.taskKey,
						agent: d.agent,
						verified: false,
						reason:
							`宿主登记的 ${children.length} 个子代理里认不到标记 ${d.token}。` +
							`可能是没真的 spawn、description 里的标记被删了、或 prompt 是自己拼的。重走 wb_expert_dispatch。`,
					});
				}
			}
			const passed = results.filter((r) => r.verified).length;
			return {
				sessionId,
				readable: true,
				verified: passed === results.length && results.length > 0,
				childrenSeen: children.length,
				checked: results.length,
				passed,
				results,
				limit:
					"回读只认到「子代理确实按这次派发起来了」（catalog 行只含 id/createdAt/mode/label）。" +
					"宿主不暴露子代理的 prompt 原文，所以**逐字比对提示词做不到**；逐字一致性由「prompt 只能来自 wb_expert_dispatch」这条规程保证。",
			};
		},
	};
}

/* ─────────────────────────── 在线市场（需 WorkBuddy 登录态） ─────────────────────────── */

/** 市场条目 → UI 轻量视图（与 /catalog 的 item 形状对齐，额外带 marketExpertId）。 */
function marketView(entry) {
	const view = entryView(entry);
	return {
		plugin: view.plugin,
		id: view.id,
		title: view.title,
		name: view.name,
		expertType: view.expertType,
		category: view.category,
		profession: view.profession,
		memberCount: view.memberCount,
		summary: view.summary,
		avatarUrl: marketAvatarUrl(view.avatar),
		marketExpertId: entry.marketExpertId,
		marketVersion: entry.marketVersion,
		useCount: entry.useCount,
	};
}

function marketStatusPayload(cfg) {
	const token = readToken();
	return {
		ok: true,
		connected: token !== undefined,
		token:
			token === undefined
				? null
				: { uid: token.uid, exp: token.exp, capturedAt: token.capturedAt },
		categories: cachedCategories(),
		cdpPort: Number(cfg?.market?.cdpPort ?? 9222),
	};
}

const MARKET_HINT =
	"在线市场需要 WorkBuddy 登录态：先关闭 WorkBuddy，再用 " +
	'"E:\\\\workbuddy\\\\WorkBuddy.exe" --remote-debugging-port=9222 启动它并保持登录，然后点「连接市场」。';

function toolMarketSearch(ctx, cfg) {
	return {
		name: "wb_market_search",
		description:
			"搜索 WorkBuddy 在线专家市场（28k+ 创作者/团队专家，需先 wb_market_capture 连接登录态）。" +
			"返回 plugin、marketExpertId、标题、类型、分类与简介；召唤用 wb_summon(plugin, marketExpertId)。",
		parameters: {
			type: "object",
			properties: {
				q: { type: "string", description: "关键词（名称/职业/简介）" },
				category: { type: "string", description: "分类 ID（来自 wb_market_search 返回的 categories 或 /market/categories）" },
				page: { type: "number", description: "页码，默认 1" },
				pageSize: { type: "number", description: "每页条数，默认 20，上限 100" },
			},
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const result = await marketSearch({
				q: typeof args?.q === "string" ? args.q : "",
				categories:
					typeof args?.category === "string" && args.category.trim().length > 0
						? [args.category.trim()]
						: [],
				page: Number.isFinite(args?.page) ? args.page : 1,
				pageSize: Number.isFinite(args?.pageSize) ? args.pageSize : 20,
			});
			return {
				connected: true,
				total: result.total,
				page: result.page,
				items: result.items.slice(0, 100).map((e) => {
					const v = marketView(e);
					return {
						plugin: v.plugin,
						marketExpertId: v.marketExpertId,
						title: v.title,
						name: v.name,
						expertType: v.expertType,
						category: v.category,
						summary: v.summary,
					};
				}),
			};
		},
	};
}

function toolMarketCapture(ctx, cfg) {
	return {
		name: "wb_market_capture",
		description:
			"连接 WorkBuddy 在线专家市场：默认从本机 WorkBuddy 调试端口（9222）抓取登录 token；" +
			"也可以直接传 token。连上后 wb_market_search 可用，市场专家可被 wb_summon 召唤。",
		parameters: {
			type: "object",
			properties: {
				port: { type: "number", description: "WorkBuddy 远程调试端口，默认 9222" },
				token: { type: "string", description: "直接给 Bearer token（JWT），省略则自动抓取" },
			},
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			if (typeof args?.token === "string" && args.token.trim().length > 0) {
				const saved = await saveToken(args.token);
				return { connected: true, uid: saved.uid, exp: saved.exp, categories: saved.categories ?? [] };
			}
			const record = await captureTokenFromWorkBuddy({
				port: Number.isFinite(args?.port) ? args.port : cfg?.market?.cdpPort,
			});
			const categories = await marketCategories({});
			return {
				connected: true,
				uid: record.uid,
				exp: record.exp,
				categories,
			};
		},
	};
}

/* ─────────────────────────── HTTP 路由（UI 用） ─────────────────────────── */

function reply(res, status, obj) {
	try {
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify(obj));
	} catch {
		/* 客户端已断开 */
	}
}

/** 头像响应：短缓存 + 内容 ETag；失败按 404/502 返回小 JSON。 */
function replyImage(req, res, img) {
	if (img === undefined || img === null) {
		reply(res, 500, { ok: false, error: "no image" });
		return;
	}
	if (img.status !== 200) {
		// 没有头像也要可缓存：否则面板里每条无图条目每次都回源探一次
		res.writeHead(img.status === 502 ? 502 : 404, { "Cache-Control": "no-store" });
		res.end(JSON.stringify({ ok: false, error: img.note ?? "no avatar" }));
		return;
	}
	// 按内容算 ETag：WorkBuddy 换了头像 → 字节变 → ETag 变 → 不会长时间吃旧缓存。
	const etag = `W/"${createHash("sha1").update(Buffer.from(img.data)).digest("hex").slice(0, 16)}"`;
	if ((req.headers?.["if-none-match"] ?? "") === etag) {
		res.writeHead(304, { ETag: etag, "Cache-Control": AVATAR_CACHE_CONTROL });
		res.end();
		return;
	}
	try {
		res.writeHead(200, {
			"Content-Type": img.mime,
			"Content-Length": String(img.data.length),
			ETag: etag,
			"Cache-Control": AVATAR_CACHE_CONTROL,
		});
		res.end(Buffer.from(img.data));
	} catch {
		/* 客户端已断开 */
	}
}

function readBody(req) {	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (c) => {
			data += c;
			if (data.length > 1e6) {
				reject(new Error("body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

function makeHandler(ctx, cfg) {
	return async (req, res) => {
		// kind:"prefix" 下 req.url 是含前缀的完整路径；两种形态都收，避免静默 404。
		const url = new URL(req.url ?? "/", "http://localhost");
		let path = url.pathname;
		if (!path.startsWith(ROUTE)) path = `${ROUTE}${path.startsWith("/") ? "" : "/"}${path}`;
		path = path.replace(/\/+$/, "");
		const seg = path.slice(ROUTE.length).replace(/^\//, "");
		const status = () => {
			const sessionId = url.searchParams.get("sessionId") ?? undefined;
			return {
				ok: true,
				route: ROUTE,
				base: COS_BASE,
				catalog: catalogCache === null
					? null
					: {
							at: new Date(catalogCache.at).toISOString(),
							total: catalogCache.views.length,
							teams: catalogCache.views.filter((v) => v.expertType === "team").length,
							sources: catalogCache.sources,
							degraded: catalogCache.degraded,
							parity: catalogCache.parity,
						},
				summon: sessionId === undefined ? listSummons() : (getSummon(sessionId) ?? null),
				injected: sessionId === undefined ? sections.size : (sections.get(sessionId)?.chars ?? 0),
				market: (() => {
					const token = readToken();
					return { connected: token !== undefined, categories: cachedCategories().length };
				})(),
			};
		};
		try {
			if (req.method === "GET" && (seg === "" || seg === "health" || seg === "status")) return reply(res, 200, status());

			if (req.method === "GET" && seg === "market/status") {
				return reply(res, 200, marketStatusPayload(cfg));
			}

			if (req.method === "GET" && seg === "market/categories") {
				try {
					return reply(res, 200, { ok: true, items: await marketCategories({}) });
				} catch (error) {
					return reply(res, 200, {
						ok: true,
						items: cachedCategories(),
						degraded: true,
						error: String(error?.message ?? error),
					});
				}
			}

			if (req.method === "GET" && seg === "market/search") {
				try {
					const result = await marketSearch({
						q: (url.searchParams.get("q") ?? "").trim(),
						categories:
							(url.searchParams.get("category") ?? "").trim().length > 0
								? [url.searchParams.get("category").trim()]
								: [],
						page: Number(url.searchParams.get("page") ?? 1),
						pageSize: Number(url.searchParams.get("pageSize") ?? 30),
					});
					return reply(res, 200, {
						ok: true,
						total: result.total,
						page: result.page,
						pageSize: result.pageSize,
						items: result.items.map(marketView),
					});
				} catch (error) {
					const code = error?.code;
					const status = code === "no-token" || code === "token-invalid" ? 401 : 502;
					return reply(res, status, {
						ok: false,
						error: String(error?.message ?? error),
						hint: MARKET_HINT,
					});
				}
			}

			if (req.method === "POST" && (seg === "market/capture" || seg === "market/token")) {
				let body = {};
				try {
					body = JSON.parse((await readBody(req)) || "{}");
				} catch {
					body = {};
				}
				try {
					if (seg === "market/token" || (typeof body.token === "string" && body.token.trim().length > 0)) {
						const saved = await saveToken(body.token);
						return reply(res, 200, {
							...marketStatusPayload(cfg),
							categories: saved.categories ?? cachedCategories(),
						});
					}
					await captureTokenFromWorkBuddy({
						port: Number.isFinite(body.port) ? body.port : cfg?.market?.cdpPort,
					});
					const categories = await marketCategories({});
					return reply(res, 200, { ...marketStatusPayload(cfg), categories });
				} catch (error) {
					return reply(res, 502, {
						ok: false,
						error: String(error?.message ?? error),
						hint: MARKET_HINT,
					});
				}
			}

			if (req.method === "GET" && seg === "catalog") {
				const cat = await catalog({ fresh: url.searchParams.get("refresh") === "1" });
				const kind = url.searchParams.get("kind") ?? "all";
				const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
				const category = (url.searchParams.get("category") ?? "").trim().toLowerCase();
				let views = cat.views;
				if (kind === "team") views = views.filter((v) => v.expertType === "team");
				else if (kind === "expert") views = views.filter((v) => v.expertType !== "team");
				if (category.length > 0) {
					views = views.filter(
						(v) =>
							String(v.categoryId ?? "").toLowerCase().includes(category) ||
							String(v.category ?? "").toLowerCase().includes(category),
					);
				}
				if (q.length > 0) {
					views = views.filter((v) =>
						`${v.name} ${v.nameEn} ${v.profession} ${v.description} ${v.tags.join(" ")} ${v.plugin}`
							.toLowerCase()
							.includes(q),
					);
				}
				// 分类顺序与 WorkBuddy 专家中心一致（清单 categories 顺序），查不到的追加在末尾。
				const categories = new Map();
				for (const c of cat.categories ?? []) categories.set(c.id, { id: c.id, name: c.name, count: 0 });
				for (const v of cat.views) {
					const key = v.categoryId ?? "uncategorized";
					if (!categories.has(key)) {
						categories.set(key, { id: key, name: v.category || key, count: 0 });
					}
					categories.get(key).count += 1;
				}
				return reply(res, 200, {
					ok: true,
					total: views.length,
					degraded: cat.degraded,
					sources: cat.sources,
					parity: cat.parity,
					cachedAt: new Date(cat.at).toISOString(),
					categories: [...categories.values()],
					// 只回 UI 列表需要的字段：entryView 全文（description/initPrompt/members）
				// 一条就有几百字节，600 条直出会肥到 MB 级。
				items: views.slice(0, 600).map((v) => ({
					plugin: v.plugin,
					id: v.id,
					title: v.title,
					name: v.name,
					expertType: v.expertType,
					category: v.category,
					profession: v.profession,
					memberCount: v.memberCount,
					summary: v.summary,
					avatarUrl: v.avatar === null || v.avatar === undefined ? null : avatarUrl(v.plugin),
					// 专家团额外带成员清单（54 条）：UI 用它渲染成员头像堆叠；头像仍走
					// /avatar?plugin=<plugin>&agent=<memberId>，不新增路由。非 team 省略该字段。
					...(v.expertType === "team"
						? { members: (v.members ?? []).map((m) => ({ id: m.id, name: m.name })) }
						: {}),
				})),
				});
			}

			if (req.method === "GET" && seg === "entry") {
				const key = url.searchParams.get("plugin") ?? "";
				const cat = await catalog({});
				const entry = findEntry(cat, key);
				if (entry === undefined) return reply(res, 404, { ok: false, error: `未找到 "${key}"` });
				const view = entryView(entry);
				const pkg = await loadPackage(view.plugin, {});
				return reply(res, 200, {
					ok: true,
					entry: view,
					pkgAvailable: pkg?.manifest !== undefined,
					agents: pkg?.agentNames ?? [],
					skills: (pkg?.skills ?? []).map((s) => ({ name: s.name, description: s.description ?? "" })),
					initPrompt: view.initPrompt,
					quickPrompts: (entry.quickPrompts ?? []).map(zh),
				});
			}

			// 头像：宿主实时代理 COS 的服务端缩略（?imageMogr2/thumbnail/Nx），本地不存图。
			// 在线市场条目的头像是 openplatform-cdn 绝对 URL，用 ?src= 走同一个代理（域名白名单）。
			if (req.method === "GET" && seg === "avatar") {
				const size = Number(url.searchParams.get("size") ?? AVATAR_DEFAULT_SIZE);
				const src = url.searchParams.get("src") ?? "";
				if (src.length > 0) {
					const img = await getAvatarBySrc(src, size);
					return replyImage(req, res, img);
				}
				const plugin = url.searchParams.get("plugin") ?? "";
				if (plugin.length === 0) return reply(res, 400, { ok: false, error: "缺少 plugin" });
				const agent = url.searchParams.get("agent") ?? undefined;
				const cat = await catalog({});
				const view = cat.views.find((v) => v.plugin === plugin);
				const img = await getAvatar(view, size, { agent, plugin });
				return replyImage(req, res, img);
			}

			if (req.method === "POST" && (seg === "summon" || seg === "unsummon")) {
				const body = JSON.parse((await readBody(req)) || "{}");
				const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
				if (sessionId === undefined || sessionId.length === 0) {
					return reply(res, 400, { ok: false, error: "缺少 sessionId" });
				}
				if (seg === "unsummon") {
					const cleared = unsummon(sessionId);
					return reply(res, 200, { ok: true, cleared, sessionId });
				}
				const result = await summon({
					sessionId,
					key: String(body.plugin ?? "").trim(),
					marketExpertId: typeof body.marketExpertId === "string" ? body.marketExpertId : undefined,
					order: typeof body.order === "string" ? body.order : undefined,
					round: Number.isFinite(body.round) ? body.round : undefined,
					fresh: body.refresh === true,
					config: cfg,
				});
				return reply(res, 200, { ok: true, ...result });
			}

			return reply(res, 404, { ok: false, error: `unknown route: ${seg || "/"}` });
		} catch (error) {
			const code = error?.code;
			const needsMarketAuth = code === "no-token" || code === "token-invalid" || code === "token-expired";
			const http =
				code === "not-found" || code === "package-unavailable"
					? 404
					: code === "bad-entry" || code === "too-large"
						? 400
						: code === "session-busy" || code === "duplicate-dispatch"
							? 409
							: needsMarketAuth
								? 401
								: 500;
			reply(res, http, {
				ok: false,
				error: String(error?.message ?? error),
				...(code === "session-busy"
					? { existingTaskKey: error.existing, incomingTaskKey: error.incoming, hint: "一个会话只跑一件事：请开新会话，或先取消当前召唤。" }
					: {}),
				...(needsMarketAuth ? { hint: MARKET_HINT } : {}),
			});
		}
	};
}

/* ─────────────────────────── apply ─────────────────────────── */

export async function apply(ctx, config) {
	const cfg = config ?? {};
	mkdirSync(SECTIONS_DIR, { recursive: true });

	// 重启恢复：把已落盘的注入段读回内存（缺失的异步补算，补算前不注入 = 安全）。
	for (const [sessionId, record] of Object.entries(listSummons())) {
		const text = loadSectionFromDisk(sessionId);
		if (text !== undefined && text.length > 0) {
			sections.set(sessionId, { text, plugin: record.plugin, chars: text.length, at: record.at });
		} else {
			void recompute(sessionId, record).catch(() => {});
		}
	}

	// 状态文件封顶：丢掉最老的会话，避免无限增长。
	const all = Object.entries(listSummons()).sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
	if (all.length > MAX_SUMMON_SESSIONS) {
		const keep = new Set(all.slice(all.length - MAX_SUMMON_SESSIONS).map(([id]) => id));
		pruneSummons(keep);
		// 派发登记与轮次跟着同一批会话一起回收，别留孤儿
		pruneDispatches(keep);
	}
	// 段落盘回收：0 字节历史遗留 + 上面封顶后新产生的孤儿（必须在 prune 之后跑）
	const swept = sweepSectionFiles();
	if (swept > 0) log(`回收 ${swept} 个失效注入段文件`);

	async function recompute(sessionId, record) {
		// 在线市场专家不在本地目录里，按 marketExpertId 重新取详情再下载包体。
		if (typeof record.marketExpertId === "string" && record.marketExpertId.length > 0) {
			try {
				const hits = await marketGetByIds([record.marketExpertId]);
				const entry = hits[0];
				if (entry === undefined) return;
				const pkg = await packageFor(entry);
				if (pkg?.manifest === undefined) return;
				await buildSection(sessionId, entry, pkg, cfg);
			} catch {
				/* 市场不可用（token 失效/离线）时保留旧段落盘，不影响其他会话 */
			}
			return;
		}
		const cat = await catalog({});
		const entry = findEntry(cat, record.entryId ? `${record.plugin}::${record.entryId}` : record.plugin)
			?? findEntry(cat, record.plugin);
		const pkg = await loadPackage(record.plugin, {});
		if (entry === undefined || pkg?.manifest === undefined) return;
		await buildSection(sessionId, entry, pkg, cfg);
	}

	// ── 注入段：未召唤 → 空串（零残留）──
	// 求值器每个模型步都跑，这里搭车数轮次：只做内存累加，落盘按批（见 lib/dispatch.js）。
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: SECTION_NAME,
				order: SECTION_ORDER,
				text: (context) => {
					const sessionId = sessionIdOf(context);
					if (sessionId === undefined) return "";
					const hit = sections.get(sessionId);
					if (hit !== undefined) {
						const t = bumpTurns(sessionId, cfg.turnBudget ?? DEFAULT_TURN_BUDGET);
						return t.warn ? `${hit.text}${turnWarning(t.steps, t.budget)}` : hit.text;
					}
					const record = getSummon(sessionId);
					if (record === undefined) return "";
					// 有召唤记录但段没就绪（重启补算中）：本轮先不注入，后台补算。
					void recompute(sessionId, record).catch(() => {});
					return "";
				},
			}),
		"dsh-workbuddy-summon: system prompt section",
	);

	// ── 模型侧工具 ──
	const builtTools = [
		toolList(ctx, cfg),
		toolRead(ctx, cfg),
		toolSummon(ctx, cfg),
		toolUnsummon(ctx),
		toolDispatch(ctx, cfg),
		toolVerify(ctx, cfg),
	];
	if (cfg.market?.enabled !== false) {
		builtTools.push(toolMarketSearch(ctx, cfg), toolMarketCapture(ctx, cfg));
	}
	for (const tool of builtTools) {
		ctx.effect(() => ctx.tools.register(tool), `dsh-workbuddy-summon: tool ${tool.name}`);
	}

	// ── UI 路由 ──
	ctx.effect(
		() => ctx.webServer.register({ kind: "prefix", path: ROUTE, handler: makeHandler(ctx, cfg) }),
		"dsh-workbuddy-summon: http route",
	);

	// 兼容垫片：把插件 bin/ 下的 westock-data / westock-tool 装进 PATH，
	// 让 WorkBuddy 专家包（其 prompt 调用的是技能目录名而非真实命令）不改一字即可运行。
	// 只覆盖带自身标记的文件，他人占用一律跳过 —— 见 lib/shims.js。
	if (cfg.installShims !== false) {
		const shims = installShims({});
		if (shims.dir !== undefined) {
			for (const dep of checkShimDeps()) {
				if (!dep.ok) log(`垫片依赖缺失：\`${dep.name}\` 不在 PATH。安装：${dep.hint}`);
			}
		}
	}

	// 目录预热：不阻塞启动，失败也不影响（首次使用会再拉）。
	if (cfg.warmCatalog !== false) {
		setTimeout(() => {
			void catalog({}).catch((error) => log("目录预热失败（首次使用时会重试）", error));
		}, 1500).unref?.();
	}

	log(`host half mounted｜召唤注入 order=${SECTION_ORDER}｜路由 ${ROUTE}/catalog`);
}
