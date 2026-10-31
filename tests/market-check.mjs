/**
 * 在线专家市场（0.3.0）host 半边离线回归 —— 用假 ctx 跑 apply()，直接调路由 handler。
 *
 *   node tests/market-check.mjs
 *
 * 隔离做法（务必先看）：
 *   测试进程先把 process.env.USERPROFILE / HOME 指到临时目录再 import index.js，
 *   于是 lib/catalog.js 的 STATE_ROOT 落在临时目录 → 宿主读到的 token 一定不存在，
 *   「未连接市场」的三条断言（status / 401 + hint / 坏 token 不落盘）都可复现。
 *   **不需要改名或读取用户真实的 market-token.json**；开头与结尾各取一次它的 sha256，
 *   断言完全一致（证明测试没有动到登录态）。
 *   万一 homedir() 没被改掉，立刻判红退出，绝不写真实目录。
 *
 * 断言：
 *   · 工具注册：默认 6 个（含 wb_market_search / wb_market_capture）；
 *     cfg.market.enabled=false → 只注册目录/召唤 4 个；
 *   · GET /market/status：connected 布尔 + categories 数组 + cdpPort（跟着 cfg）；
 *   · GET /market/search 无 token → 401 + hint（含 9222 启动指引），GET /market/categories 降级不报错；
 *   · POST /market/token 坏 token → 502 + hint，且不落盘；
 *   · GET /avatar?src=：白名单外一律 404（含后缀伪造 / http / 非图片扩展名）；
 *     白名单内只断言「不 500、不抛」（404/502 都算正常，不依赖外网可用性）。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};
const skip = (label, why) => console.log(`  - SKIP ${label}${why ? ` — ${why}` : ""}`);
const sha256 = (path) => {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
};

/* 真实登录态文件（只取哈希） */
const REAL_TOKEN = join(homedir(), ".dsh", "workbuddy-summon", "market-token.json");
const realBefore = sha256(REAL_TOKEN);

/* ── 隔离：临时 HOME ── */
const TEMP_HOME = mkdtempSync(join(tmpdir(), "dsh-wb-market-check-"));
const savedEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = TEMP_HOME;
process.env.HOME = TEMP_HOME;

const R = "/dsh-workbuddy-summon";

/** 假 ctx：只实现 apply() 用到的四个扩展点，其余给空实现。 */
function makeCtx() {
	const calls = { sections: [], tools: [], routes: [], effects: 0 };
	const ctx = {
		effect(fn) {
			calls.effects += 1;
			const d = fn();
			return typeof d === "function" ? d : () => {};
		},
		on: () => () => {},
		systemPrompt: {
			section(def) {
				calls.sections.push(def);
				return () => {};
			},
		},
		tools: {
			register(def) {
				calls.tools.push(def);
				return () => {};
			},
		},
		webServer: {
			register(def) {
				calls.routes.push(def);
				return () => {};
			},
		},
		agents: { currentInitiator: () => ({ sessionId: "market-probe", session: { header: { id: "market-probe" } } }) },
		logger: { info: () => {}, warn: () => {} },
	};
	return { ctx, calls };
}

/** handler 只用到 req.method / req.url / 事件流，一个 EventEmitter 就够。 */
function fakeReq(method, url, body) {
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.destroy = () => {};
	req.headers = {};
	queueMicrotask(() => {
		if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
		req.emit("end");
	});
	return req;
}

async function call(handler, method, url, body) {
	const chunks = [];
	const res = {
		statusCode: null,
		headers: {},
		writeHead(s, h) {
			this.statusCode = s;
			this.headers = h ?? {};
		},
		end(x) {
			if (x !== undefined) chunks.push(Buffer.isBuffer(x) ? x : Buffer.from(String(x)));
		},
	};
	await handler(fakeReq(method, url, body), res);
	const buf = Buffer.concat(chunks);
	let json;
	try {
		json = JSON.parse(buf.toString("utf8"));
	} catch {
		json = undefined;
	}
	return { status: res.statusCode, headers: res.headers, buf, json };
}

try {
	/* ── 隔离校验（不通过就绝不继续） ── */
	const catalog = await import("../lib/catalog.js");
	const STATE_ROOT = catalog.STATE_ROOT;
	if (!STATE_ROOT.startsWith(TEMP_HOME)) {
		console.error(`✗ 无法把 STATE_ROOT 隔离到临时目录（实得 ${STATE_ROOT}）—— 为避免动到真实 token 直接退出`);
		fails += 1;
		throw Object.assign(new Error("isolate"), { code: "isolate" });
	}
	ok("STATE_ROOT 已隔离到临时目录", true, STATE_ROOT.replace(TEMP_HOME, "<tmp>"));
	const TOKEN_FILE = join(STATE_ROOT, "market-token.json");
	ok("隔离目录里没有 token（等价于「未连接市场」）", !existsSync(TOKEN_FILE));

	const mod = await import("../index.js");
	if (mod.name !== "dsh-workbuddy-summon") throw new Error("模块 name 不对");

	/* ── 两次装配：市场开（默认）/ 市场关（cfg.market.enabled=false） ── */
	const A = makeCtx();
	await mod.apply(A.ctx, { warmCatalog: false, installShims: false, market: { cdpPort: 9333 } });
	const handlerA = A.calls.routes[0]?.handler;
	const B = makeCtx();
	await mod.apply(B.ctx, { warmCatalog: false, installShims: false, market: { enabled: false } });
	const handlerB = B.calls.routes[0]?.handler;
	ok("两次装配都注册了 1 条前缀路由", typeof handlerA === "function" && typeof handlerB === "function");

	console.log("\n① 工具注册：市场开关");
	const namesA = A.calls.tools.map((t) => t.name);
	const namesB = B.calls.tools.map((t) => t.name);
	ok("市场开 → 8 个工具（6 目录/召唤/派发 + 2 市场）", namesA.length === 8, namesA.join(", "));
	ok(
		"wb_market_search / wb_market_capture 已注册",
		namesA.includes("wb_market_search") && namesA.includes("wb_market_capture"),
		namesA.filter((n) => n.startsWith("wb_market_")).join(", "),
	);
	ok("市场关 → 只注册 6 个目录/召唤/派发工具", namesB.length === 6, namesB.join(", "));
	ok(
		"市场关 → 两个市场工具都不注册",
		!namesB.includes("wb_market_search") && !namesB.includes("wb_market_capture"),
		namesB.filter((n) => n.startsWith("wb_market_")).join(",") || "0 个",
	);
	const baseTools = [
		"wb_experts_list",
		"wb_expert_read",
		"wb_summon",
		"wb_unsummon",
		"wb_expert_dispatch",
		"wb_expert_verify",
	];
	ok("6 个原有工具在两种装配下都在", baseTools.every((n) => namesA.includes(n) && namesB.includes(n)));
	const marketTools = A.calls.tools.filter((t) => t.name.startsWith("wb_market_"));
	const badSchema = marketTools.filter(
		(t) =>
			t.parameters?.type !== "object" ||
			typeof t.parameters?.properties !== "object" ||
			t.parameters?.additionalProperties !== false ||
			typeof t.execute !== "function" ||
			typeof t.output?.render !== "function" ||
			t.output?.schema === undefined,
	);
	ok("市场工具的 parameters/output 是完整契约", badSchema.length === 0, badSchema.map((t) => t.name).join(",") || "2/2");
	const summonParams = A.calls.tools.find((t) => t.name === "wb_summon")?.parameters?.properties ?? {};
	ok("wb_summon 新增 marketExpertId 参数", summonParams.marketExpertId?.type === "string", summonParams.marketExpertId?.type ?? "缺");

	console.log("\n② GET /market/status：连接态 / 分类 / 调试端口");
	const st = await call(handlerA, "GET", `${R}/market/status`);
	ok("200 + ok", st.status === 200 && st.json?.ok === true, `${st.status}`);
	ok("connected 是布尔且为 false（无 token）", typeof st.json?.connected === "boolean" && st.json.connected === false, String(st.json?.connected));
	ok("categories 是数组（无缓存 → 空）", Array.isArray(st.json?.categories) && st.json.categories.length === 0, JSON.stringify(st.json?.categories));
	ok("cdpPort 跟随 cfg.market.cdpPort（9333）", st.json?.cdpPort === 9333, String(st.json?.cdpPort));
	ok("未连接时 token 字段为 null（不泄露任何 token）", st.json?.token === null, String(st.json?.token));
	const stB = await call(handlerB, "GET", `${R}/market/status`);
	ok("市场关时 /market/status 仍可用，cdpPort 回默认 9222", stB.status === 200 && stB.json?.cdpPort === 9222, `${stB.status} / ${stB.json?.cdpPort}`);
	const health = await call(handlerA, "GET", `${R}/status`);
	ok(
		"/status 也带 market.connected 布尔（UI 首屏用）",
		health.status === 200 && typeof health.json?.market?.connected === "boolean",
		JSON.stringify(health.json?.market),
	);

	console.log("\n③ 无 token：搜索 401 + hint，分类降级不报错");
	const search = await call(handlerA, "GET", `${R}/market/search?q=${encodeURIComponent("网文")}&page=1&pageSize=20`);
	ok("GET /market/search → 401（不是 500）", search.status === 401, String(search.status));
	ok("返回 ok:false + error", search.json?.ok === false && typeof search.json?.error === "string", String(search.json?.error).slice(0, 40));
	const hint = search.json?.hint;
	ok("带 hint 且是字符串", typeof hint === "string" && hint.length > 20, `${String(hint).length} 字符`);
	ok("hint 提到调试端口 9222 与登录态", /--remote-debugging-port=9222/.test(String(hint)) && /登录/.test(String(hint)));
	ok("hint 指路「连接市场」", /连接市场/.test(String(hint)));
	const cats = await call(handlerA, "GET", `${R}/market/categories`);
	ok(
		"GET /market/categories 降级 → 200 + 空清单 + degraded",
		cats.status === 200 && cats.json?.ok === true && Array.isArray(cats.json?.items) && cats.json?.degraded === true,
		`${cats.status} items=${cats.json?.items?.length} degraded=${cats.json?.degraded}`,
	);
	const saveBad = await call(handlerA, "POST", `${R}/market/token`, { token: "abc" });
	ok("POST /market/token 坏 token → 502 + hint", saveBad.status === 502 && typeof saveBad.json?.hint === "string", String(saveBad.status));
	ok("坏 token 不会被落盘", !existsSync(TOKEN_FILE));

	console.log("\n④ 头像代理：域名白名单（→ 不联网）");
	const evil = await call(handlerA, "GET", `${R}/avatar?src=${encodeURIComponent("https://evil.example.com/x.png")}`);
	ok("白名单外域名 → 404", evil.status === 404 && evil.json?.ok === false, `${evil.status} ${evil.json?.error}`);
	const spoof = await call(
		handlerA,
		"GET",
		`${R}/avatar?src=${encodeURIComponent("https://openplatform-cdn.codebuddy.cn.evil.example.com/x.png")}`,
	);
	ok("后缀伪造域名（cdn.cn.evil.com）→ 404", spoof.status === 404, String(spoof.status));
	const plain = await call(handlerA, "GET", `${R}/avatar?src=${encodeURIComponent("http://openplatform-cdn.codebuddy.cn/x.png")}`);
	ok("http（非 https）→ 404", plain.status === 404, String(plain.status));
	const notImage = await call(handlerA, "GET", `${R}/avatar?src=${encodeURIComponent("https://openplatform-cdn.codebuddy.cn/x.zip")}`);
	ok("非图片扩展名 → 404", notImage.status === 404, String(notImage.status));

	console.log("\n⑤ 头像代理：白名单内只断言「不崩」");
	const cdn = "https://openplatform-cdn.codebuddy.cn/qa-probe/__dsh-market-absent__.png";
	const warns = [];
	const realWarn = console.warn;
	console.warn = (...a) => warns.push(a.map(String).join(" "));
	let cdnRes;
	try {
		cdnRes = await Promise.race([
			call(handlerA, "GET", `${R}/avatar?src=${encodeURIComponent(cdn)}&size=64`),
			new Promise((resolve) => setTimeout(() => resolve("timeout"), 25_000).unref?.()),
		]);
	} catch (error) {
		cdnRes = { thrown: error };
	} finally {
		console.warn = realWarn;
	}
	if (cdnRes === "timeout") {
		skip("白名单域名头像回源", "25s 内未返回（外网不可用），不判红");
	} else if (cdnRes?.thrown !== undefined) {
		ok("白名单域名头像回源不抛异常", false, String(cdnRes.thrown?.message ?? cdnRes.thrown));
	} else {
		ok("白名单域名头像回源不 500", cdnRes.status !== 500 && cdnRes.status !== undefined, `status=${cdnRes.status}`);
		ok("允许 200 / 404 / 502（404 缺失、502 上游异常都算正常降级）", [200, 404, 502].includes(cdnRes.status), String(cdnRes.status));
		if (cdnRes.status === 200) {
			ok("200 时 Content-Type 是图片", /^image\//.test(cdnRes.headers["Content-Type"] ?? ""), cdnRes.headers["Content-Type"]);
		} else {
			ok("非 200 时返回小 JSON（不伪造图片）", cdnRes.json?.ok === false, `${cdnRes.buf.length}B`);
		}
	}
	const leak = warns.filter((w) => /eyJ[A-Za-z0-9_-]{10,}/.test(w));
	ok("头像失败日志不打印任何 token", leak.length === 0, leak.length ? leak[0].slice(0, 40) : "0 处");

	console.log("\n⑥ 原有路由未被市场改动影响");
	const nosid = await call(handlerA, "POST", `${R}/summon`, { plugin: "design-engine" });
	ok("POST /summon 缺 sessionId → 400", nosid.status === 400, String(nosid.status));
	const unknown = await call(handlerA, "GET", `${R}/market/nope`);
	ok("未知 /market/ 子路径 → 404（不是 500）", unknown.status === 404, String(unknown.status));
	assert.ok(A.calls.effects > 0 && B.calls.effects > 0);
	ok("两次装配的 effect 数量正确（10 = 1 段 + 8 工具 + 1 路由｜市场关 8 = 1 段 + 6 工具 + 1 路由）", A.calls.effects === 10 && B.calls.effects === 8, `${A.calls.effects} / ${B.calls.effects}`);
} catch (error) {
	if (error?.code !== "isolate") {
		fails += 1;
		console.error("测试异常：", error?.stack ?? error);
	}
} finally {
	/* ── 还原环境 + 清理临时目录 + 证明真实 token 未被触碰 ── */
	process.env.USERPROFILE = savedEnv.USERPROFILE;
	if (savedEnv.HOME === undefined) delete process.env.HOME;
	else process.env.HOME = savedEnv.HOME;
	try {
		rmSync(TEMP_HOME, { recursive: true, force: true });
	} catch {
		/* 临时目录删不掉不影响结论 */
	}
	ok(
		"真实 market-token.json 未被触碰（sha256 前后一致）",
		sha256(REAL_TOKEN) === realBefore,
		realBefore === null ? "本机本来就没有 token 文件" : `sha256 ${String(realBefore).slice(0, 12)}…`,
	);
	console.log(
		fails === 0
			? "\n== MARKET-CHECK 全部通过：工具开关 / status / 401+hint / 头像白名单 / 不丢 token =="
			: `\n== 失败 ${fails} 项 ==`,
	);
	process.exit(fails === 0 ? 0 : 1);
}
