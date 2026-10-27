/**
 * 会话级召唤的隔离验证（纯 Node，不需要 Electron / 不需要真 DSH）。
 *
 *   node tests/session-isolation-check.mjs
 *
 * 机制：`systemPrompt.section` 的求值器按 sessionId 查内存表；`wb_summon` / `wb_unsummon`
 * 与 `POST /summon|/unsummon` 都写同一个按 sessionId 分桶的状态。本用例用假 ctx 跑
 * `apply()`，从三条入口验证「召唤只作用于当前会话」：
 *
 *   · A 召唤后：A 的注入段非空；B、未召唤过的会话、缺 context 的求值 → 全部空串；
 *   · B 召唤另一个专家后：A、B 文本各自独立，互不覆盖；
 *   · 路由召唤第三个会话 C：A/B 不受影响；
 *   · 取消 A：A 回到空串，B/C 保持；
 *   · 测试结束自清理，不在真实会话状态里留痕。
 */
import { EventEmitter } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const calls = { sections: [], tools: [], routes: [] };
const ctx = {
	effect: (f) => {
		const d = f();
		return typeof d === "function" ? d : () => {};
	},
	on: () => () => {},
	systemPrompt: { section: (def) => (calls.sections.push(def), () => {}) },
	tools: { register: (def) => (calls.tools.push(def), () => {}) },
	webServer: { register: (def) => (calls.routes.push(def), () => {}) },
	agents: { currentInitiator: () => ({ sessionId: CURRENT }) },
	logger: { info() {}, warn() {} },
};

let CURRENT = "iso-probe-A";
const SESSIONS = ["iso-probe-A", "iso-probe-B", "iso-probe-C"];
let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const mod = await import("../index.js");
await mod.apply(ctx, { maxLeadChars: 24_000, warmCatalog: false });
const section = calls.sections[0];
const evalFor = (sessionId) => {
	const text = section.text(sessionId === undefined ? undefined : { agent: { sessionId } });
	return typeof text === "string" ? text : "";
};
const tool = (name) => calls.tools.find((t) => t.name === name);
const summonTool = tool("wb_summon");
const unsummonTool = tool("wb_unsummon");

/** 路由调用：只用到 req.method/url 与 readBody 的 data/end 事件。 */
async function call(method, path, body) {
	const chunks = [];
	const res = {
		statusCode: null,
		headers: null,
		writeHead(s, h) {
			this.statusCode = s;
			this.headers = h;
		},
		end(x) {
			if (x !== undefined) chunks.push(Buffer.isBuffer(x) ? x : Buffer.from(String(x)));
		},
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
	try {
		json = JSON.parse(raw);
	} catch {
		json = { _raw: raw.slice(0, 160) };
	}
	return { status: res.statusCode, json };
}

const cleanup = async () => {
	for (const sid of SESSIONS) {
		CURRENT = sid;
		try {
			await unsummonTool.execute({});
		} catch {
			/* 没召唤过也无所谓 */
		}
	}
	CURRENT = "iso-probe-A";
};

let bad = false;
try {
	/* ── ① 未召唤 → 零注入 ── */
	console.log("① 未召唤：零注入");
	const beforeA = evalFor("iso-probe-A");
	ok("A 未召唤时注入长度为 0", beforeA === "", `${beforeA.length} 字符`);
	ok("B 未召唤时注入长度为 0", evalFor("iso-probe-B") === "");
	ok("context 缺失时注入长度为 0", evalFor(undefined) === "");

	/* ── ② A 召唤 → 只影响 A ── */
	console.log("\n② A 召唤：只影响 A");
	CURRENT = "iso-probe-A";
	const sumA = await summonTool.execute({ plugin: "design-engine" });
	ok("wb_summon 返回会话 id", sumA?.sessionId === "iso-probe-A", String(sumA?.sessionId));
	ok("A 触发 systemPrompt 注入", sumA?.chars > 0, `${sumA?.chars} 字符`);
	const textA = evalFor("iso-probe-A");
	const textB0 = evalFor("iso-probe-B");
	ok("A 注入段非空", textA.length > 1000, `${textA.length} 字符`);
	ok("B 仍是空串（隔离）", textB0 === "", `${textB0.length} 字符`);
	ok("A 的注入里含调度映射", textA.includes("spawn_teammate"));

	/* ── ③ B 召唤另一个专家 → 两条互不覆盖 ── */
	console.log("\n③ B 召唤：A/B 各自独立");
	CURRENT = "iso-probe-B";
	const sumB = await summonTool.execute({ plugin: "content-creator" });
	ok("B 召唤成功", sumB?.chars > 0, `${sumB?.chars} 字符`);
	const textB = evalFor("iso-probe-B");
	ok("B 注入段非空", textB.length > 200, `${textB.length} 字符`);
	ok("B 的注入与 A 不同", textB !== textA);
	ok("A 的注入未被 B 覆盖", evalFor("iso-probe-A") === textA);
	ok("A/B 的召唤记录不同", sumA.plugin !== sumB.plugin, `${sumA.plugin} vs ${sumB.plugin}`);

	/* ── ④ 路由入口同样按 sessionId 隔离 ── */
	console.log("\n④ 路由召唤：第三个会话互不影响");
	const routeSum = await call("POST", "/dsh-workbuddy-summon/summon", {
		sessionId: "iso-probe-C",
		plugin: "content-creator",
	});
	ok("POST /summon 成功", routeSum.status === 200, `status=${routeSum.status}`);
	const textC = evalFor("iso-probe-C");
	ok("C 注入段非空", textC.length > 200, `${textC.length} 字符`);
	ok("A/B 不受 C 影响", evalFor("iso-probe-A") === textA && evalFor("iso-probe-B") === textB);

	/* ── ⑤ 取消 A → 只清 A ── */
	console.log("\n⑤ 取消 A：只清 A");
	CURRENT = "iso-probe-A";
	const un = await unsummonTool.execute({});
	ok("wb_unsummon 返回 cleared", un?.cleared === true, JSON.stringify(un).slice(0, 90));
	ok("A 回到空串", evalFor("iso-probe-A") === "");
	ok("B 保持非空", evalFor("iso-probe-B").length > 200);
	ok("C 保持非空", evalFor("iso-probe-C").length > 200);
	ok("B/C 文本仍是召唤时的内容", evalFor("iso-probe-B") === textB && evalFor("iso-probe-C") === textC);

	/* ── ⑥ 落盘纪律：状态按 sessionId 分桶 ── */
	console.log("\n⑥ 状态文件按 sessionId 分桶");
	const store = join(homedir(), ".dsh/workbuddy-summon/summons.json");
	const state = existsSync(store) ? JSON.parse(readFileSync(store, "utf8") || "{}") : {};
	ok("A 已从状态删除", !("iso-probe-A" in state));
	ok("B / C 各一条记录", Boolean(state["iso-probe-B"]) && Boolean(state["iso-probe-C"]));
} catch (error) {
	bad = true;
	console.error(`\n✗ 用例执行出错：${error?.stack ?? error}`);
} finally {
	await cleanup();
}

/* 清理后复查：测试会话全部无注入 */
if (!bad) {
	const leftovers = SESSIONS.filter((sid) => evalFor(sid) !== "");
	ok("自清理后测试会话全部回到空串", leftovers.length === 0, leftovers.join(",") || "0 条");
}

console.log(
	!bad && fails === 0
		? "\nSESSION-ISOLATION 全部通过（召唤只作用于当前会话，未召唤零注入）"
		: `\n失败 ${fails + (bad ? 1 : 0)} 项`,
);
process.exit(!bad && fails === 0 ? 0 : 1);
