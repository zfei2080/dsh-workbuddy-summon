/**
 * 任务绑定验证（纯 Node，不需要 Electron / 不需要真 DSH）。
 *
 *   node tests/task-binding-check.mjs
 *
 * 覆盖 0.5.0 新增的三条纪律，每条都是「宿主今天拦不住、只能靠模型自觉」的地方：
 *
 *   · 一事一会话：同会话换事项/换角色 → 拒；同任务键再召唤 → 放行且算续做；
 *     同事项同角色但轮次+1 → 拒（逐轮换新实例必须开新会话）；
 *     升级前留下的无 taskKey 记录 → 不拦（否则会把用户正在用的会话锁死）。
 *   · 派发不由模型拼：wb_expert_dispatch 自己读定义原文、自己拼 prompt、算指纹、登记；
 *     同 order+agent+round 重复派发 → 拒；round+1 → 放行（返工换新实例）。
 *   · 派完能核对：wb_expert_verify 读宿主真实登记的子代理目录认 wb: 标记；
 *     认不到 → mismatch；宿主没提供该服务 → readable:false 且**不算通过**。
 *   · 轮次预算：到 80% 时注入段末尾追加预警（求值器搭车计数）。
 *
 * 测试结束自清理，不在真实会话状态里留痕。
 */
import { EventEmitter } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PACK = "all-domain-brain-trust";
const MEMBER = "software-engineer";
const SESSIONS = ["tbind-probe-A", "tbind-probe-B", "tbind-probe-L"];
/** 预算压到 10 步，好在几十次求值内就触发预警线（8 步）。 */
const TURN_BUDGET = 10;

const calls = { sections: [], tools: [], routes: [] };
/** 假宿主的子代理目录。undefined = 宿主没提供该服务（用来验降级路径）。 */
let CHILDREN = undefined;
let CURRENT = SESSIONS[0];

const ctx = {
	effect: (f) => {
		const d = f();
		return typeof d === "function" ? d : () => {};
	},
	on: () => () => {},
	get: (name) => {
		if (name !== "subagents") return undefined;
		return { listChildren: async () => CHILDREN };
	},
	systemPrompt: { section: (def) => (calls.sections.push(def), () => {}) },
	tools: { register: (def) => (calls.tools.push(def), () => {}) },
	webServer: { register: (def) => (calls.routes.push(def), () => {}) },
	agents: { currentInitiator: () => ({ sessionId: CURRENT }) },
	logger: { info() {}, warn() {} },
};

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};
/** 断言一次调用确实抛了，并返回错误对象（用来验错误码与文案）。 */
async function expectThrow(label, fn) {
	try {
		await fn();
		ok(label, false, "本该拒绝，却放行了");
		return undefined;
	} catch (error) {
		ok(label, true, error?.code ?? String(error?.message ?? error).slice(0, 60));
		return error;
	}
}

const mod = await import("../index.js");
await mod.apply(ctx, { maxLeadChars: 24_000, warmCatalog: false, turnBudget: TURN_BUDGET });
const section = calls.sections[0];
const evalFor = (sessionId) => {
	const text = section.text(sessionId === undefined ? undefined : { agent: { sessionId } });
	return typeof text === "string" ? text : "";
};
const tool = (name) => calls.tools.find((t) => t.name === name);
const tSummon = tool("wb_summon");
const tUnsummon = tool("wb_unsummon");
const tDispatch = tool("wb_expert_dispatch");
const tVerify = tool("wb_expert_verify");

async function call(method, path, body) {
	const chunks = [];
	const res = {
		statusCode: null,
		writeHead(s) { this.statusCode = s; },
		end(x) { if (x !== undefined) chunks.push(Buffer.isBuffer(x) ? x : Buffer.from(String(x))); },
	};
	const req = new EventEmitter();
	req.method = method;
	req.url = path;
	req.destroy = () => {};
	req.headers = {};
	queueMicrotask(() => {
		if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
		req.emit("end");
	});
	await calls.routes[0].handler(req, res);
	const raw = Buffer.concat(chunks).toString();
	let json;
	try { json = JSON.parse(raw); } catch { json = { _raw: raw.slice(0, 200) }; }
	return { status: res.statusCode, json };
}

const cleanup = async () => {
	for (const sid of SESSIONS) {
		CURRENT = sid;
		try { await tUnsummon.execute({}); } catch { /* 没召唤过也无所谓 */ }
	}
	CURRENT = SESSIONS[0];
	CHILDREN = undefined;
};

let bad = false;
try {
	ok("四个工具都注册了", [tSummon, tUnsummon, tDispatch, tVerify].every((t) => t !== undefined));

	/* ── ① 一事一会话：异键拒绝 ── */
	console.log("\n① 一事一会话：同会话换角色 → 拒");
	CURRENT = SESSIONS[0];
	const s1 = await tSummon.execute({ plugin: PACK, order: "WO-900", round: 1 });
	ok("首次召唤成功并带回任务键", s1?.taskKey === `WO-900::${PACK}::r1`, String(s1?.taskKey));
	ok("首次召唤 continuation=0", s1?.continuation === 0, String(s1?.continuation));
	ok("注入段写出了任务键", evalFor(SESSIONS[0]).includes("WO-900"));

	const busy = await expectThrow("同会话换角色（content-creator）→ 拒", () =>
		tSummon.execute({ plugin: "content-creator", order: "WO-900", round: 1 }));
	ok("拒绝码是 session-busy（不是笼统 500）", busy?.code === "session-busy", String(busy?.code));
	ok("拒绝文案点明要开新会话", /开一个新会话/.test(String(busy?.message ?? "")));
	ok("被拒后原召唤没被覆盖", evalFor(SESSIONS[0]).includes(PACK));

	const busy2 = await expectThrow("同会话换事项（WO-901）→ 拒", () =>
		tSummon.execute({ plugin: PACK, order: "WO-901", round: 1 }));
	ok("换事项同样是 session-busy", busy2?.code === "session-busy", String(busy2?.code));

	/* ── ② 同键续做 ── */
	console.log("\n② 同任务键再召唤 → 放行且算续做");
	const s2 = await tSummon.execute({ plugin: PACK, order: "WO-900", round: 1 });
	ok("同键放行", s2?.taskKey === s1.taskKey, String(s2?.taskKey));
	ok("continuation 递增到 1", s2?.continuation === 1, String(s2?.continuation));
	ok("续做会带回「不许重做」的交代", /不许重做/.test(String(s2?.note ?? "")), String(s2?.note ?? "").slice(0, 40));
	ok("注入段出现续做标记", evalFor(SESSIONS[0]).includes("续做"));

	/* ── ③ 轮次+1 必须开新会话 ── */
	console.log("\n③ 同事项同角色但轮次+1 → 拒（逐轮换新实例）");
	const busy3 = await expectThrow("round 1→2 在同会话 → 拒", () =>
		tSummon.execute({ plugin: PACK, order: "WO-900", round: 2 }));
	ok("轮次+1 也是 session-busy", busy3?.code === "session-busy", String(busy3?.code));
	ok("文案专门交代返工要换新会话", /返工换轮次|换新会话/.test(String(busy3?.message ?? "")));

	/* ── ④ 不同会话互不影响（回归） ── */
	console.log("\n④ 不同会话各自独立");
	CURRENT = SESSIONS[1];
	const sB = await tSummon.execute({ plugin: PACK, order: "WO-901", round: 1 });
	ok("B 会话用另一个事项召唤成功", sB?.taskKey === `WO-901::${PACK}::r1`, String(sB?.taskKey));
	ok("A 的注入未被 B 覆盖", evalFor(SESSIONS[0]).includes("WO-900"));
	ok("B 的注入是自己的事项", evalFor(SESSIONS[1]).includes("WO-901"));

	/* ── ⑤ 路由入口同样受闸 ── */
	console.log("\n⑤ HTTP 路由入口同样受闸");
	const r1 = await call("POST", "/dsh-workbuddy-summon/summon", {
		sessionId: SESSIONS[0], plugin: "content-creator", order: "WO-900",
	});
	ok("路由换角色 → 409（不是 500）", r1.status === 409, `status=${r1.status}`);
	ok("409 带回两个任务键，便于定位", r1.json?.existingTaskKey !== undefined && r1.json?.incomingTaskKey !== undefined,
		`${r1.json?.existingTaskKey} vs ${r1.json?.incomingTaskKey}`);

	/* ── ⑤b 升级安全：遗留记录不拦 ── */
	console.log("\n⑤b 升级前留下的记录（无 taskKey）不拦，接管后补上键");
	// 0.4.0 及以前的 summons.json 里没有 taskKey。要是拿新闸去拦它，
	// 用户升级后正在用的会话会被一次性锁死 —— 那是升级事故，不是纪律。
	const { setSummon: legacySet } = await import("../lib/state.js");
	legacySet("tbind-probe-L", { plugin: PACK, kind: "team", title: "遗留记录" });
	CURRENT = "tbind-probe-L";
	const sL = await tSummon.execute({ plugin: "content-creator", order: "WO-902", round: 1 });
	ok("遗留会话换成别的专家 → 放行（不锁死）", sL?.taskKey === `WO-902::content-creator::r1`, String(sL?.taskKey));
	ok("接管后补上了任务键", typeof sL?.taskKey === "string" && sL.taskKey.includes("::"));
	const sL2 = await expectThrow("接管之后再换角色 → 就开始拦了", () =>
		tSummon.execute({ plugin: PACK, order: "WO-902", round: 1 }));
	ok("接管后闸生效", sL2?.code === "session-busy", String(sL2?.code));

	/* ── ⑥ 派发：prompt 由插件拼，不由模型拼 ── */
	console.log("\n⑥ wb_expert_dispatch：插件自己读原文自己拼");
	CURRENT = SESSIONS[0];
	const d1 = await tDispatch.execute({ agent: MEMBER, task: "实现 task-901，产出代码与自测说明。", order: "WO-900", round: 1 });
	ok("返回的 name 就是 Agent ID（不是中文名）", d1?.name === MEMBER, String(d1?.name));
	ok("prompt 开头是成员定义原文（含 frontmatter）", String(d1?.prompt ?? "").startsWith("---"), String(d1?.prompt ?? "").slice(0, 20));
	ok("prompt 末尾接上了本次任务", String(d1?.prompt ?? "").includes("实现 task-901"));
	ok("prompt 整段不截断（定义原文全长都在，再拼上任务）",
		d1?.promptChars === d1?.prompt?.length && d1.promptChars > d1.definitionChars,
		`定义 ${d1?.definitionChars} → prompt ${d1?.promptChars}`);
	ok("description 里带 wb: 标记", /\[wb:[0-9a-f]{12}\]/.test(String(d1?.description ?? "")), String(d1?.description));
	ok("指纹是 64 位 sha256", /^[0-9a-f]{64}$/.test(String(d1?.fingerprint ?? "")), String(d1?.fingerprint ?? "").slice(0, 16));
	ok("token 是指纹前 12 位", d1?.token === `wb:${d1.fingerprint.slice(0, 12)}`, String(d1?.token));

	// 指纹稳定性：同输入同指纹；定义原文变一个字就变
	const { fingerprint: fpFn } = await import("../lib/dispatch.js");
	const md = d1.prompt.slice(0, d1.definitionChars);
	ok("同输入 → 同指纹（可复算）", fpFn({ agent: MEMBER, md, taskKey: d1.taskKey }) === d1.fingerprint);
	ok("定义原文改一个字 → 指纹变（表面像查得出来）",
		fpFn({ agent: MEMBER, md: `${md}。`, taskKey: d1.taskKey }) !== d1.fingerprint);
	ok("换成别的成员 → 指纹变", fpFn({ agent: "software-architect", md, taskKey: d1.taskKey }) !== d1.fingerprint);

	/* ── ⑦ 一事一专家一轮次 ── */
	console.log("\n⑦ 同 order+agent+round 重复派发 → 拒；round+1 → 放行");
	const dup = await expectThrow("同轮次重复派发同一成员 → 拒", () =>
		tDispatch.execute({ agent: MEMBER, task: "再来一次。", order: "WO-900", round: 1 }));
	ok("重复派发码是 duplicate-dispatch", dup?.code === "duplicate-dispatch", String(dup?.code));
	ok("拒绝文案给了出路（round+1 或 send_message）", /round|send_message/.test(String(dup?.message ?? "")));

	const d2 = await tDispatch.execute({ agent: MEMBER, task: "返工：按评审意见修 fix1。", order: "WO-900", round: 2 });
	ok("round+1 放行（返工换新实例）", d2?.round === 2 && d2?.taskKey === `WO-900::${MEMBER}::r2`, String(d2?.taskKey));
	ok("round+1 是新指纹（不是复用上一个实例）", d2?.fingerprint !== d1.fingerprint);

	const dOther = await tDispatch.execute({ agent: "software-architect", task: "评审 task-901。", order: "WO-900", round: 1 });
	ok("同轮次派另一个成员不受影响", dOther?.name === "software-architect", String(dOther?.name));

	const dInherit = await tDispatch.execute({ agent: "software-qa-engineer", task: "验收 task-901。" });
	ok("未传 order → 继承会话任务键的事项段", dInherit?.order === "WO-900", String(dInherit?.order));
	ok("未传 round → 默认第 1 轮", dInherit?.round === 1, String(dInherit?.round));

	const noMember = await expectThrow("派发不存在的成员 → 拒", () =>
		tDispatch.execute({ agent: "not-a-member", task: "x", order: "WO-900", round: 1 }));
	ok("错误里列出可用成员，不让模型瞎猜", /可用：/.test(String(noMember?.message ?? "")));

	/* ── ⑧ 核对：认宿主真实登记的子代理 ── */
	console.log("\n⑧ wb_expert_verify：读宿主目录认标记");
	// 8a 宿主没提供该服务 → 如实报「核对不了」，且不算通过
	CHILDREN = undefined;
	const vDeg = await tVerify.execute({ agent: MEMBER, round: 1 });
	ok("宿主无子代理服务 → readable:false", vDeg?.readable === false, String(vDeg?.readable));
	ok("降级时 verified 必须是 false（读不到≠通过）", vDeg?.verified === false, String(vDeg?.verified));
	ok("降级文案明说「不得据此声称已核实」", /不得据此声称/.test(String(vDeg?.reason ?? "")), String(vDeg?.reason ?? "").slice(0, 40));

	// 8b 认到标记 → 通过
	CHILDREN = [
		{ id: "child-1", createdAt: 1, mode: "continuable", label: `软件工程师 · ${MEMBER} [${d1.token}]` },
		{ id: "child-2", createdAt: 2, mode: "continuable", label: `架构师 · software-architect [${dOther.token}]` },
	];
	const vHit = await tVerify.execute({ agent: MEMBER, round: 1 });
	ok("认到标记 → readable:true 且 verified:true", vHit?.readable === true && vHit?.verified === true, JSON.stringify(vHit?.results ?? []).slice(0, 90));
	ok("回读带回真实子代理 id（不是模型自述）", vHit?.results?.[0]?.childId === "child-1", String(vHit?.results?.[0]?.childId));
	ok("结论里如实写明「逐字比对做不到」", /逐字比对提示词做不到/.test(String(vHit?.limit ?? "")), String(vHit?.limit ?? "").slice(0, 40));

	// 8c 认不到标记 → mismatch，且不算通过
	CHILDREN = [{ id: "child-9", createdAt: 9, mode: "continuable", label: "某专家 · software-engineer [wb:deadbeefdead]" }];
	const vMiss = await tVerify.execute({ agent: MEMBER, round: 2 });
	ok("认不到标记 → verified:false", vMiss?.verified === false, String(vMiss?.verified));
	ok("认不到时点明可能原因", /没真的 spawn|标记被删|自己拼的/.test(String(vMiss?.results?.[0]?.reason ?? "")), String(vMiss?.results?.[0]?.reason ?? "").slice(0, 50));

	// 8d 同一标记认到两个子代理 → 同轮被 spawn 了两次
	CHILDREN = [
		{ id: "c-a", createdAt: 1, mode: "continuable", label: `x [${dOther.token}]` },
		{ id: "c-b", createdAt: 2, mode: "continuable", label: `y [${dOther.token}]` },
	];
	const vDup = await tVerify.execute({ agent: "software-architect", round: 1 });
	ok("同标记认到 2 个子代理 → 判不通过", vDup?.verified === false && /spawn 了多次/.test(String(vDup?.results?.[0]?.reason ?? "")),
		String(vDup?.results?.[0]?.reason ?? "").slice(0, 40));

	// 8e 没有派发登记就来核对 → 不当成通过
	CHILDREN = [];
	const vNone = await tVerify.execute({ agent: "ui-designer", round: 1 });
	ok("无派发登记 → verified:false 且叫它先走 dispatch", vNone?.verified === false && /先调 wb_expert_dispatch/.test(String(vNone?.reason ?? "")),
		String(vNone?.reason ?? "").slice(0, 40));

	/* ── ⑨ 轮次预算预警 ── */
	console.log("\n⑨ 轮次预算：到 80% 追加预警");
	const warnLine = TURN_BUDGET * 0.8;
	let sawWarn = false;
	let steps = 0;
	for (let i = 0; i < TURN_BUDGET + 4; i += 1) {
		const text = evalFor(SESSIONS[0]);
		steps = i + 1;
		if (text.includes("接近轮次上限") || text.includes("达到预算")) sawWarn = true;
	}
	ok(`到 ${warnLine} 步（预算 ${TURN_BUDGET} 的 80%）出现预警`, sawWarn);
	ok("预警叫人收尾交接、不许再开大改动", evalFor(SESSIONS[0]).includes("续做交接"));
	ok("超过预算后升级成 🛑", evalFor(SESSIONS[0]).includes("达到预算"));
	ok("未召唤的会话不计数也不注入", evalFor("tbind-probe-never") === "");

	/* ── ⑩ 落盘与自清理 ── */
	console.log("\n⑩ 落盘纪律");
	const root = join(homedir(), ".dsh/workbuddy-summon");
	const summonStore = existsSync(join(root, "summons.json")) ? JSON.parse(readFileSync(join(root, "summons.json"), "utf8") || "{}") : {};
	ok("召唤记录带 taskKey/order/round/continuations",
		summonStore[SESSIONS[0]]?.taskKey === `WO-900::${PACK}::r1`
		&& summonStore[SESSIONS[0]]?.order === "WO-900"
		&& summonStore[SESSIONS[0]]?.round === 1
		&& typeof summonStore[SESSIONS[0]]?.continuations === "number",
		JSON.stringify(summonStore[SESSIONS[0]] ?? {}).slice(0, 120));
	const dispStore = existsSync(join(root, "dispatches.json")) ? JSON.parse(readFileSync(join(root, "dispatches.json"), "utf8") || "{}") : {};
	const mine = Object.values(dispStore).filter((d) => d.sessionId === SESSIONS[0]);
	ok("派发登记落了盘且带指纹与标记", mine.length >= 4 && mine.every((d) => /^[0-9a-f]{64}$/.test(d.fingerprint ?? "") && /^wb:/.test(d.token ?? "")),
		`${mine.length} 条`);
	ok("核对通过的记录标了 verified 与真实 childId", mine.some((d) => d.status === "verified" && d.childId === "child-1"));
	ok("核对不通过的记录留痕为 mismatch（不删除）", mine.some((d) => d.status === "mismatch"));
} catch (error) {
	bad = true;
	console.error(`\n✗ 用例执行出错：${error?.stack ?? error}`);
} finally {
	await cleanup();
}

if (!bad) {
	const left = SESSIONS.filter((sid) => evalFor(sid) !== "");
	ok("自清理后测试会话全部回到空串", left.length === 0, left.join(",") || "0 条");
	const root = join(homedir(), ".dsh/workbuddy-summon");
	const dispStore = existsSync(join(root, "dispatches.json")) ? JSON.parse(readFileSync(join(root, "dispatches.json"), "utf8") || "{}") : {};
	const live = Object.values(dispStore).filter((d) => SESSIONS.includes(d.sessionId) && d.status !== "revoked");
	ok("取消召唤后派发登记全部撤销", live.length === 0, `${live.length} 条未撤销`);
}

console.log(
	!bad && fails === 0
		? "\nTASK-BINDING 全部通过（一事一会话 / 派发不由模型拼 / 派完可核对 / 轮次有预算）"
		: `\n失败 ${fails + (bad ? 1 : 0)} 项`,
);
process.exit(!bad && fails === 0 ? 0 : 1);
