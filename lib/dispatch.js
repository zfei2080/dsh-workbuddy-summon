/**
 * 任务键、成员派发登记、轮次预算、身份指纹。
 *
 * 为什么需要这一层：宿主的召唤状态（lib/state.js）只回答「这个会话现在是哪个专家」，
 * 回答不了「这个专家正在跑哪一件事、跑到第几轮、成员是不是真的按那份定义起来的」。
 * 三件事都落成可核对的记录，身份才不靠模型自觉。
 *
 * 任务键 = order（哪件事）× role（哪个角色）× round（第几轮）：
 *   · 同一会话换 order 或换 role ⇒ 是另一件事，必须开新会话；
 *   · 同键再来一次 ⇒ 续做（例如撞了轮次上限后接手现场），放行并计数；
 *   · 同 order 同 role 但 round+1 ⇒ 返工换一个新实例（评审逐轮换人），
 *     因为键不同，会被当成新派发，不会复用上一个。
 *
 * 落盘：~/.dsh/workbuddy-summon/{dispatches,turns}.json，与宿主版本无关。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { STATE_ROOT } from "./catalog.js";

const DISPATCH_STORE = join(STATE_ROOT, "dispatches.json");
const TURN_STORE = join(STATE_ROOT, "turns.json");

/** 一轮的默认预算。撞上限被强制终止后要能「续做」而不是重做，所以预算要提前预警。 */
export const DEFAULT_TURN_BUDGET = 150;
/** 预警线：预算的 80%。到线就在注入段里提醒收尾，别等被砍。 */
const WARN_RATIO = 0.8;
/** 轮次每累计这么多步落一次盘，避免每个模型步都写文件。 */
const TURN_FLUSH_EVERY = 10;
const MAX_DISPATCHES = 2000;

/** @type {Map<string, object>} 键 `${sessionId}\u0000${taskKey}` */
const dispatches = new Map();
/** @type {Map<string, {steps: number, at: string}>} 键 sessionId */
const turns = new Map();
let loaded = false;

const SEP = "\u0000";

function readJson(file) {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeJson(file, value) {
	try {
		mkdirSync(STATE_ROOT, { recursive: true });
		writeFileSync(file, JSON.stringify(value, null, 1));
		return true;
	} catch (error) {
		console.warn(`[dsh-workbuddy-summon] ${file} 落盘失败：${error?.message ?? error}`);
		return false;
	}
}

function ensureLoaded() {
	if (loaded) return;
	loaded = true;
	for (const [k, v] of Object.entries(readJson(DISPATCH_STORE))) {
		if (typeof k === "string" && v !== null && typeof v === "object") dispatches.set(k, v);
	}
	for (const [k, v] of Object.entries(readJson(TURN_STORE))) {
		if (typeof k === "string" && typeof v?.steps === "number") turns.set(k, { steps: v.steps, at: v.at });
	}
}

function persistDispatches() {
	const entries = [...dispatches.entries()];
	// 封顶：留最新的 MAX_DISPATCHES 条，避免文件无限增长
	const kept = entries.length > MAX_DISPATCHES
		? entries.sort((a, b) => String(a[1].at).localeCompare(String(b[1].at))).slice(entries.length - MAX_DISPATCHES)
		: entries;
	if (kept.length !== entries.length) {
		dispatches.clear();
		for (const [k, v] of kept) dispatches.set(k, v);
	}
	return writeJson(DISPATCH_STORE, Object.fromEntries(kept));
}

/* ─────────────────────────── 任务键 ─────────────────────────── */

const clean = (v) => String(v ?? "").trim().replace(/[\u0000\r\n]+/g, " ");

/**
 * 组装任务键。order 缺省用 "-"（未指定），role 必填，round 缺省 1。
 * @returns {string} 形如 `WO-755::software-engineer::r2`
 */
export function makeTaskKey({ order, role, round } = {}) {
	const r = Number.isFinite(round) ? Math.max(1, Math.floor(round)) : 1;
	const o = clean(order);
	const ro = clean(role);
	if (ro.length === 0) throw new Error("taskKey: 缺少 role（角色 / 专家包名 / 成员 Agent ID）");
	return `${o.length > 0 ? o : "-"}::${ro}::r${r}`;
}

export function parseTaskKey(key) {
	const parts = String(key ?? "").split("::");
	if (parts.length !== 3) return undefined;
	const round = Number(parts[2].replace(/^r/, ""));
	return { order: parts[0], role: parts[1], round: Number.isFinite(round) ? round : 1 };
}

/* ─────────────────────────── 身份指纹 ─────────────────────────── */

/**
 * 专家身份指纹：绑定「哪个成员 + 哪份定义原文 + 哪个任务键」。
 * 定义原文变一个字，指纹就变 —— 这样「表面像、提示词其实不是那个专家」会被查出来。
 */
export function fingerprint({ agent, md, taskKey }) {
	return createHash("sha256")
		.update(`${clean(agent)}${SEP}${String(taskKey ?? "")}${SEP}${String(md ?? "")}`)
		.digest("hex");
}

/**
 * 骑在 spawn 的 description 上的短标记。
 * 宿主把子代理登记进 subagentCatalog 时会带一个 label，回读时靠这个标记认出
 * 「这个子代理是本次派发起的」，而不是听模型自述。
 */
export function shortToken(fp) {
	return `wb:${String(fp ?? "").slice(0, 12)}`;
}

/* ─────────────────────────── 派发登记 ─────────────────────────── */

const dkey = (sessionId, taskKey) => `${sessionId}${SEP}${taskKey}`;

/**
 * 登记一次成员派发。同键重复登记会被拒（一事一专家一轮次只能派一次）。
 * @returns {{ok: true, record: object} | {ok: false, reason: string, record: object}}
 */
export function recordDispatch({ sessionId, taskKey, agent, fingerprint: fp, promptChars, label, order, round }) {
	ensureLoaded();
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw new Error("dispatch: 缺少 sessionId");
	}
	const key = dkey(sessionId, taskKey);
	const prev = dispatches.get(key);
	if (prev !== undefined && prev.status !== "revoked") {
		return { ok: false, reason: "duplicate", record: prev };
	}
	const record = {
		sessionId,
		taskKey,
		order: clean(order) || "-",
		round: Number.isFinite(round) ? Math.max(1, Math.floor(round)) : 1,
		agent: clean(agent),
		fingerprint: String(fp ?? ""),
		token: shortToken(fp),
		label: typeof label === "string" ? label : "",
		promptChars: Number.isFinite(promptChars) ? promptChars : 0,
		status: "dispatched",
		childId: null,
		verifiedAt: null,
		at: new Date().toISOString(),
	};
	dispatches.set(key, record);
	persistDispatches();
	return { ok: true, record };
}

export function getDispatch(sessionId, taskKey) {
	ensureLoaded();
	return dispatches.get(dkey(sessionId, taskKey));
}

/** 列出某会话的全部派发（给 verify 与 UI 用）。 */
export function listDispatches(sessionId) {
	ensureLoaded();
	const out = [];
	for (const record of dispatches.values()) {
		if (record.sessionId === sessionId) out.push(record);
	}
	return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** 把一条派发标记为已核对（回读到了宿主登记的子代理）。 */
export function markVerified(sessionId, taskKey, childId) {
	ensureLoaded();
	const key = dkey(sessionId, taskKey);
	const prev = dispatches.get(key);
	if (prev === undefined) return undefined;
	const next = {
		...prev,
		status: "verified",
		childId: typeof childId === "string" ? childId : prev.childId,
		verifiedAt: new Date().toISOString(),
	};
	dispatches.set(key, next);
	persistDispatches();
	return next;
}

/** 标记核对不通过（回读到了对不上的东西）。留痕，不删除。 */
export function markMismatch(sessionId, taskKey, detail) {
	ensureLoaded();
	const key = dkey(sessionId, taskKey);
	const prev = dispatches.get(key);
	if (prev === undefined) return undefined;
	const next = { ...prev, status: "mismatch", mismatch: String(detail ?? ""), verifiedAt: new Date().toISOString() };
	dispatches.set(key, next);
	persistDispatches();
	return next;
}

/** 取消召唤时连带撤销该会话的派发登记。 */
export function revokeDispatches(sessionId) {
	ensureLoaded();
	let n = 0;
	for (const [key, record] of [...dispatches.entries()]) {
		if (record.sessionId !== sessionId) continue;
		dispatches.set(key, { ...record, status: "revoked" });
		n += 1;
	}
	if (n > 0) persistDispatches();
	return n;
}

/* ─────────────────────────── 轮次预算 ─────────────────────────── */

/**
 * 记一个模型步。宿主每个模型步都会求值一次注入段，这里搭车计数。
 * 内存累加，每 TURN_FLUSH_EVERY 步落一次盘 —— 求值器里不能做重活。
 * @returns {{steps: number, budget: number, warn: boolean, over: boolean}}
 */
export function bumpTurns(sessionId, budget = DEFAULT_TURN_BUDGET) {
	ensureLoaded();
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		return { steps: 0, budget, warn: false, over: false };
	}
	const prev = turns.get(sessionId);
	const steps = (prev?.steps ?? 0) + 1;
	const entry = { steps, at: new Date().toISOString() };
	turns.set(sessionId, entry);
	if (steps % TURN_FLUSH_EVERY === 0 || steps === Math.floor(budget * WARN_RATIO)) {
		writeJson(TURN_STORE, Object.fromEntries(turns));
	}
	return { steps, budget, warn: steps >= budget * WARN_RATIO, over: steps >= budget };
}

export function resetTurns(sessionId) {
	ensureLoaded();
	const had = turns.delete(sessionId);
	if (had) writeJson(TURN_STORE, Object.fromEntries(turns));
	return had;
}

/** 清理已消失会话的登记（与 pruneSummons 同款纪律）。 */
export function pruneDispatches(liveIds) {
	ensureLoaded();
	if (!(liveIds instanceof Set)) return 0;
	let removed = 0;
	for (const [key, record] of [...dispatches.entries()]) {
		if (!liveIds.has(record.sessionId)) {
			dispatches.delete(key);
			removed += 1;
		}
	}
	for (const sid of [...turns.keys()]) {
		if (!liveIds.has(sid)) {
			turns.delete(sid);
			removed += 1;
		}
	}
	if (removed > 0) {
		persistDispatches();
		writeJson(TURN_STORE, Object.fromEntries(turns));
	}
	return removed;
}
