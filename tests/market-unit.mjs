/**
 * 在线专家市场（0.3.0）纯函数回归 —— 直接 import lib/market.js，全程不联网。
 *
 *   node tests/market-unit.mjs
 *
 * 隔离做法（务必先看）：
 *   先把 process.env.USERPROFILE / HOME 指到一个临时目录，再动态 import 被测模块；
 *   lib/catalog.js 的 STATE_ROOT = homedir()/.dsh/workbuddy-summon 因此落在临时目录里，
 *   本用例写 / 删的全是临时文件。开头与结尾各取一次**真实** market-token.json 的 sha256
 *   并断言完全一致 —— 证明本用例没有改名、没有覆盖、也没有读取用户登录态内容。
 *   万一 homedir() 没被改掉（换了平台或 Node 行为变化），立刻判红退出，绝不写真实目录。
 *
 * 断言：
 *   · marketItemToEntry：用真实市场响应样本（2026-10 抓取）校验字段映射，
 *     外加 team / 缺字段兜底 / tags 长短不一 / 纯函数不改入参；
 *   · readToken：缺失 / 坏 JSON / 过短 / 过期 JWT → undefined；有效 JWT → 记录形状正确；
 *   · saveToken：格式错 / 已过期在**写盘前**就拒绝，且不落盘；
 *   · ensureMarketPackage：缺参在联网前就报 bad-args；
 *   · cachedCategories：无缓存 / 正常 / 坏 JSON / 形状错；
 *   · MARKET_ORIGIN / MARKET_API 契约（路由路径是宿主与 UI 的共同契约）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};
const sha256 = (path) => {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
};

/* 真实登录态文件（只取哈希，不读取内容做断言） */
const REAL_TOKEN = join(homedir(), ".dsh", "workbuddy-summon", "market-token.json");
const realBefore = sha256(REAL_TOKEN);

/* ── 隔离：临时 HOME ── */
const TEMP_HOME = mkdtempSync(join(tmpdir(), "dsh-wb-market-unit-"));
const savedEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = TEMP_HOME;
process.env.HOME = TEMP_HOME;

let m; // lib/market.js
let STATE_ROOT;
let CACHE_ROOT;

try {
	const catalog = await import("../lib/catalog.js");
	STATE_ROOT = catalog.STATE_ROOT;
	CACHE_ROOT = catalog.CACHE_ROOT;
	if (!STATE_ROOT.startsWith(TEMP_HOME)) {
		console.error(`✗ 无法把 STATE_ROOT 隔离到临时目录（实得 ${STATE_ROOT}）—— 为避免动到真实 token 直接退出`);
		fails += 1;
		throw Object.assign(new Error("isolate"), { code: "isolate" });
	}
	ok("STATE_ROOT 已隔离到临时目录", true, STATE_ROOT.replace(TEMP_HOME, "<tmp>"));

	m = await import("../lib/market.js");

	const TOKEN_FILE = join(STATE_ROOT, "market-token.json");
	const CATEGORIES_FILE = join(CACHE_ROOT, "market-categories.json");
	const put = (path, text) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	};
	const now = Math.floor(Date.now() / 1000);
	/** 造一个结构合法（但不验签）的 JWT：header.payload.signature */
	const seal = (payload) =>
		`${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.` +
		`${Buffer.from(JSON.stringify(payload)).toString("base64url")}.` +
		"q".repeat(43);

	console.log("\n① MARKET_ORIGIN / MARKET_API 契约");
	ok("MARKET_ORIGIN 是 workbuddy 主站", m.MARKET_ORIGIN === "https://www.workbuddy.cn", m.MARKET_ORIGIN);
	const apiKeys = Object.keys(m.MARKET_API).sort().join(",");
	ok("MARKET_API 四个端点齐全", apiKeys === "byIds,categories,downloadUrl,list", apiKeys);
	const badPaths = Object.entries(m.MARKET_API).filter(
		([, p]) => typeof p !== "string" || !p.startsWith("/v2/operation-platform/market/"),
	);
	ok("端点路径都在 /v2/operation-platform/market/ 下", badPaths.length === 0, badPaths.map(([k]) => k).join(",") || "4/4");

	console.log("\n② marketItemToEntry：真实响应样本的字段映射");
	/** 真实样本（WorkBuddy 在线市场 list 接口返回的第 1 条，原样拷贝，勿改）。 */
	const SAMPLE = {
		expert_id: "ex_k9IhFsyCcwFN",
		source_id: "ex_k9IhFsyCcwFN",
		expert_type: "agent",
		plugin_id: "pl_KhnWufygH0XK",
		plugin_version: "1.3.22",
		icon: "https://openplatform-cdn.codebuddy.cn/public/178acaee-8160-4a1b-965d-287755a15309/avatar/expert/eza_ceacad7d-6a0.jpg",
		agent_name: "training-marketing-expert",
		version: "1.3.22",
		lifecycle_status: "published",
		display_name_zh: "萧厚霖",
		display_name_en: "Xiao Houlin",
		profession_zh: "教培招生运营",
		profession_en: "Training Enrollment Operations",
		description_zh: "教培的招生、续费、团队、算账，先看三个数再动手。",
		description_en: "Enrollment, retention, team, and the P&L for training schools - look at the numbers first.",
		source: "openapi",
		quick_prompts: [
			{ zh: "续费率一直在掉，帮我看看问题可能出在哪？", en: "Our renewal rate keeps slipping - where might the problem be?" },
			{ zh: "销售团队人均产出一直上不去，是该加人还是先抓管理？", en: "My sales team's per-head output just won't lift." },
		],
		categories: ["12-IndustryConsultant", "05-MarketingGrowth", "15-Education"],
		categories_detail: [
			{ id: "12-IndustryConsultant", name_zh: "行业顾问", name_en: "Industry Consultant" },
			{ id: "05-MarketingGrowth", name_zh: "营销增长", name_en: "Marketing Growth" },
			{ id: "15-Education", name_zh: "教育学习", name_en: "Education & Learning" },
		],
		tags_zh: ["培训行业营销管理", "招生漏斗排查", "续费与定价"],
		tags_en: ["Training Industry Marketing Management", "Enrollment Funnel Diagnosis", "Retention & Pricing"],
		homepage: "https://github.com/training-marketing-expert",
		use_count: 192,
		distribution_scope: 1,
		plugin_name: "training-marketing-expert",
		default_init_prompt: { zh: "续费率一直在掉，帮我看看问题可能出在哪？", en: "Our renewal rate keeps slipping - where might the problem be?" },
		created_at: "2026-10-27T02:14:05Z",
		updated_at: "2026-10-27T02:14:06Z",
	};
	const before = JSON.stringify(SAMPLE);
	const entry = m.marketItemToEntry(SAMPLE);
	const expected = {
		id: "ex_k9IhFsyCcwFN",
		plugin: "training-marketing-expert",
		expertType: "agent",
		displayName: { zh: "萧厚霖", en: "Xiao Houlin" },
		profession: { zh: "教培招生运营", en: "Training Enrollment Operations" },
		description: { zh: SAMPLE.description_zh, en: SAMPLE.description_en },
		avatar: SAMPLE.icon,
		tags: [
			{ zh: "培训行业营销管理", en: "Training Industry Marketing Management" },
			{ zh: "招生漏斗排查", en: "Enrollment Funnel Diagnosis" },
			{ zh: "续费与定价", en: "Retention & Pricing" },
		],
		quickPrompts: SAMPLE.quick_prompts,
		defaultInitPrompt: SAMPLE.default_init_prompt,
		agentName: "training-marketing-expert",
		categoryId: "12-IndustryConsultant",
		categoryName: "行业顾问",
		useCount: 192,
		_manifest: "market",
		marketExpertId: "ex_k9IhFsyCcwFN",
		marketVersion: "1.3.22",
	};
	try {
		assert.deepStrictEqual(entry, expected);
		ok("真实样本 → 目录条目字段逐项一致", true, `${Object.keys(expected).length} 个字段`);
	} catch (error) {
		ok("真实样本 → 目录条目字段逐项一致", false, String(error?.message ?? error).slice(0, 400));
	}
	ok("纯函数：不改写入参", JSON.stringify(SAMPLE) === before);
	ok("头像是 openplatform-cdn 绝对 URL", /^https:\/\/openplatform-cdn\.codebuddy(?:\.cn|\.ai)\//.test(entry.avatar), entry.avatar?.slice(0, 48) + "…");

	/* team 与兜底 */
	const teamEntry = m.marketItemToEntry({ ...SAMPLE, expert_type: "team", display_name_zh: "招生运营团" });
	ok('expert_type="team" → expertType="team"', teamEntry.expertType === "team", teamEntry.expertType);
	const minimal = m.marketItemToEntry({ expert_id: "ex_only", plugin_id: "pl_only" });
	ok("缺 source_id → id 用 expert_id", minimal.id === "ex_only", String(minimal.id));
	ok("缺 plugin_name → plugin 用 plugin_id", minimal.plugin === "pl_only", String(minimal.plugin));
	ok("缺 expert_type → 默认 agent", minimal.expertType === "agent", minimal.expertType);
	ok(
		"缺双语字段 → 中文名回退 expert_id，其余空串",
		minimal.displayName.zh === "ex_only" && minimal.displayName.en === "" &&
			minimal.profession.zh === "" && minimal.description.zh === "",
		JSON.stringify(minimal.displayName),
	);
	ok("缺 icon → avatar 为 undefined", minimal.avatar === undefined, String(minimal.avatar));
	ok("缺 tags/quick_prompts → 空数组", minimal.tags.length === 0 && minimal.quickPrompts.length === 0);
	ok("缺 use_count → 0", minimal.useCount === 0, String(minimal.useCount));
	ok("useCount 数字字符串会被转成数字", m.marketItemToEntry({ ...SAMPLE, use_count: "128" }).useCount === 128);
	ok("icon 非字符串 → avatar undefined", m.marketItemToEntry({ ...SAMPLE, icon: null }).avatar === undefined);
	const partialTags = m.marketItemToEntry({ ...SAMPLE, tags_zh: ["只有中文"], tags_en: ["en-1", "en-2"] });
	ok(
		"tags 中英长度不一致 → 以长为准逐项补齐",
		partialTags.tags.length === 2 && partialTags.tags[0].en === "en-1" && partialTags.tags[1].zh === "en-2",
		JSON.stringify(partialTags.tags),
	);

	console.log("\n③ isMarketEntry：UI / 召唤的判定口径");
	ok("有 marketExpertId → true", m.isMarketEntry({ marketExpertId: "ex_1" }) === true);
	ok("空串 marketExpertId → false", m.isMarketEntry({ marketExpertId: "" }) === false);
	ok("缺字段 / null / 非字符串 → false", m.isMarketEntry({}) === false && m.isMarketEntry(null) === false && m.isMarketEntry({ marketExpertId: 7 }) === false);

	console.log("\n④ readToken：本地 token 的读取与过期判定");
	rmSync(TOKEN_FILE, { force: true });
	ok("没有 token 文件 → undefined", m.readToken() === undefined);
	put(TOKEN_FILE, "{这不是 JSON");
	ok("坏 JSON → undefined", m.readToken() === undefined);
	put(TOKEN_FILE, JSON.stringify({ token: "too-short" }));
	ok("token 过短（<20 字符）→ undefined", m.readToken() === undefined);
	put(TOKEN_FILE, JSON.stringify({ token: seal({ sub: "uid-expired", exp: now - 60 }) }));
	ok("过期 JWT → undefined", m.readToken() === undefined);
	const goodExp = now + 28 * 24 * 3600;
	put(TOKEN_FILE, JSON.stringify({ token: seal({ sub: "uid-sub", exp: goodExp }) }));
	const good = m.readToken();
	ok("有效 JWT → 返回记录", good !== undefined && good.token.startsWith("eyJ"), good === undefined ? "undefined" : "有记录");
	ok("uid 缺省取 JWT 的 sub", good?.uid === "uid-sub", String(good?.uid));
	ok("exp 为秒级时间戳", good?.exp === goodExp, String(good?.exp));
	put(TOKEN_FILE, JSON.stringify({ token: seal({ sub: "uid-x", exp: goodExp }), uid: "record-uid", capturedAt: "2026-10-27T17:37:54.000Z" }));
	const good2 = m.readToken();
	ok("记录里的 uid / capturedAt 优先保留", good2?.uid === "record-uid" && good2?.capturedAt === "2026-10-27T17:37:54.000Z", `${good2?.uid} @ ${good2?.capturedAt}`);
	put(TOKEN_FILE, JSON.stringify({ token: seal({ sub: "uid-noexp" }) }));
	const noExp = m.readToken();
	ok("无 exp 的 JWT → 不过期（exp 为 undefined）", noExp !== undefined && noExp.exp === undefined && noExp.uid === "uid-noexp");
	put(TOKEN_FILE, JSON.stringify({ token: "z".repeat(40) }));
	const junk = m.readToken();
	ok(
		"非 JWT 随机串（≥20 字符）当前被放行 —— 本地不验签，坏 token 由市场 API 401 兜底",
		junk !== undefined && junk.uid === "" && junk.exp === undefined,
		junk === undefined ? "undefined" : "有记录（宽松点，非回归）",
	);

	console.log("\n⑤ saveToken：写盘前先校验（不会因为坏 token 落盘）");
	rmSync(TOKEN_FILE, { force: true });
	const rejects = async (label, fn, code) => {
		try {
			await fn();
			ok(label, false, "没有拒绝（意外成功）");
		} catch (error) {
			ok(label, error?.code === code, `${error?.code ?? "?"} / ${String(error?.message ?? error).slice(0, 40)}`);
		}
	};
	await rejects("短 token → bad-token", () => m.saveToken("abc"), "bad-token");
	await rejects('"Bearer " 前缀剥掉后过短 → bad-token', () => m.saveToken("Bearer x"), "bad-token");
	await rejects("过期 JWT → token-expired", () => m.saveToken(seal({ sub: "u", exp: now - 10 })), "token-expired");
	ok("以上失败都没落盘", sha256(TOKEN_FILE) === null, "token 文件不存在");

	console.log("\n⑥ ensureMarketPackage：缺参在联网前就拒绝");
	await rejects("两个参数都缺 → bad-args", () => m.ensureMarketPackage({}), "bad-args");
	await rejects("缺 plugin → bad-args", () => m.ensureMarketPackage({ expertId: "ex_1" }), "bad-args");
	await rejects("缺 expertId → bad-args", () => m.ensureMarketPackage({ plugin: "p" }), "bad-args");

	console.log("\n⑦ cachedCategories：离线分类缓存");
	rmSync(CATEGORIES_FILE, { force: true });
	ok("无缓存 → []", Array.isArray(m.cachedCategories()) && m.cachedCategories().length === 0);
	const cats = [
		{ id: "12-IndustryConsultant", name: "行业顾问", count: 120, order: 3 },
		{ id: "05-MarketingGrowth", name: "营销增长", count: 88, order: 1 },
	];
	put(CATEGORIES_FILE, JSON.stringify({ at: "2026-10-27T17:37:54.000Z", items: cats }));
	const cached = m.cachedCategories();
	ok("正常缓存 → 原样返回", JSON.stringify(cached) === JSON.stringify(cats), `${cached.length} 个分类`);
	put(CATEGORIES_FILE, "{坏 JSON");
	ok("坏 JSON → []", m.cachedCategories().length === 0);
	put(CATEGORIES_FILE, JSON.stringify({ items: "不是数组" }));
	ok("items 不是数组 → []", m.cachedCategories().length === 0);
	put(CATEGORIES_FILE, "null");
	ok("文件内容为 null → []", m.cachedCategories().length === 0);
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
			? "\n== MARKET-UNIT 全部通过：字段映射 / token 读写与过期 / 缓存 / 参数校验（全程不联网）=="
			: `\n== 失败 ${fails} 项 ==`,
	);
	process.exit(fails === 0 ? 0 : 1);
}
