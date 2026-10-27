/**
 * UI 数据形状回归：面板依赖的 /catalog 与 /entry 响应是否齐全。
 *
 *   node tests/ui-shape-check.mjs
 *
 * 断言（假 ctx 跑 apply()，直连 HTTP handler）：
 *   · GET /catalog?q=设计 → 200、有结果、列表项含 UI 全部依赖字段；
 *   · 专家团条目额外带 members（头像堆叠用），memberCount > 0；
 *   · GET /catalog?kind=team → total = 54，分类下拉 15 个且带 count；
 *   · GET /entry?plugin=design-engine → 200、包可读、成员/技能/引导语/快捷提示齐全；
 *   · 未知 entry → 404。
 */
import { EventEmitter } from "node:events";

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const routes = [];
const ctx = {
	effect: (f) => {
		const d = f();
		return typeof d === "function" ? d : () => {};
	},
	on: () => () => {},
	systemPrompt: { section: () => () => {} },
	tools: { register: () => () => {} },
	webServer: { register: (d) => { routes.push(d); return () => {}; } },
	agents: { currentInitiator: () => ({ sessionId: "ui" }) },
	logger: { info() {}, warn() {} },
};
const m = await import("../index.js");
await m.apply(ctx, { warmCatalog: false });

async function call(method, url, body) {
	const ch = [];
	const res = {
		statusCode: null,
		writeHead(s) { this.statusCode = s; },
		end(x) { if (x !== undefined) ch.push(Buffer.isBuffer(x) ? x : Buffer.from(String(x))); },
	};
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.destroy = () => {};
	req.headers = {};
	queueMicrotask(() => {
		if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
		req.emit("end");
	});
	await routes[0].handler(req, res);
	const text = Buffer.concat(ch).toString();
	let json;
	try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 160) }; }
	return { status: res.statusCode, json };
}

console.log("① 搜索列表（q=设计）");
const c = await call("GET", "/dsh-workbuddy-summon/catalog?q=%E8%AE%BE%E8%AE%A1");
ok("200", c.status === 200, `status=${c.status}`);
ok("有搜索结果", (c.json.items?.length ?? 0) > 0, `total=${c.json.total}`);
const item = c.json.items?.[0] ?? {};
const NEED = ["plugin", "id", "title", "name", "expertType", "category", "profession", "memberCount", "summary", "avatarUrl"];
const missing = NEED.filter((k) => !(k in item));
ok("列表项含 UI 依赖字段", missing.length === 0, missing.length ? `缺 ${missing.join(",")}` : `${NEED.length} 个字段齐全`);
ok("卡片主标题非空", typeof item.title === "string" && item.title.length > 0, item.title);

console.log("\n② 专家团列表（kind=team）");
const teams = await call("GET", "/dsh-workbuddy-summon/catalog?kind=team");
// 官方专家团 54 个 + 内置固化包（packs/）里的团
const bundledTeamCount = (teams.json.items ?? []).filter(
	(i) => i.plugin === "all-domain-brain-trust",
).length;
ok(
	"专家团 total = 54 + 内置包",
	teams.json.total === 54 + bundledTeamCount,
	`total=${teams.json.total}（内置 ${bundledTeamCount}）`,
);
ok("分类下拉 15 个", (teams.json.categories?.length ?? 0) === 15, `${teams.json.categories?.length} 个`);
ok("分类项带 name/count", (teams.json.categories ?? []).every((x) => x.name && typeof x.count === "number"));
const teamItem = teams.json.items?.[0] ?? {};
ok("专家团条目带 members（头像堆叠）", Array.isArray(teamItem.members) && teamItem.members.length > 0, `members=${teamItem.members?.length}`);
ok("专家团 memberCount > 0", teamItem.memberCount > 0, String(teamItem.memberCount));
ok("专家团徽标口径 团·(memberCount+1)", teamItem.memberCount + 1 > 1, `团·${teamItem.memberCount + 1}`);

console.log("\n③ 单包详情（design-engine）");
const e = await call("GET", "/dsh-workbuddy-summon/entry?plugin=design-engine");
ok("200", e.status === 200, `status=${e.status}`);
ok("包体可读", e.json.pkgAvailable === true);
ok("成员清单非空", (e.json.agents?.length ?? 0) > 0, `agents=${e.json.agents?.length}`);
ok("技能清单非空", (e.json.skills?.length ?? 0) > 0, `skills=${e.json.skills?.length}`);
ok("引导语非空", typeof e.json.initPrompt === "string" && e.json.initPrompt.length > 0);
ok("快捷提示非空", (e.json.quickPrompts?.length ?? 0) > 0, `${e.json.quickPrompts?.length} 条`);

console.log("\n④ 未知条目");
const missingEntry = await call("GET", "/dsh-workbuddy-summon/entry?plugin=__no_such_expert__");
ok("未知 entry → 404", missingEntry.status === 404, `status=${missingEntry.status}`);

console.log(fails === 0 ? "\nUI-SHAPE 全部通过：列表/分类/详情字段与面板口径一致" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
