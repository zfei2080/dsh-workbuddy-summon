/** 头像 HTTP 路由验证（假 ctx 直连 handler）：二进制响应、mime、缓存头、404 语义。 */
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
	agents: { currentInitiator: () => ({ sessionId: "a" }) },
	logger: { info() {}, warn() {} },
};
const m = await import("../index.js");
await m.apply(ctx, { warmCatalog: false });

async function raw(method, url, extraHeaders) {
	const chunks = [];
	const res = {
		statusCode: null,
		headers: null,
		writeHead(s, h) { this.statusCode = s; this.headers = h; },
		end(x) { if (x !== undefined) chunks.push(Buffer.isBuffer(x) ? x : Buffer.from(x)); },
	};
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.destroy = () => {};
	req.headers = extraHeaders ?? {};
	queueMicrotask(() => req.emit("end"));
	await routes[0].handler(req, res);
	return { status: res.statusCode, headers: res.headers ?? {}, body: Buffer.concat(chunks) };
}

console.log("① 整团头像");
let r = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine&size=64");
ok("200 + image/*", r.status === 200 && /^image\//.test(r.headers["Content-Type"] ?? ""), `${r.status} ${r.headers["Content-Type"]}`);
ok("PNG 魔数", r.body.subarray(1, 4).toString() === "PNG");
ok("Content-Length 与实际一致", Number(r.headers["Content-Length"]) === r.body.length, `${r.headers["Content-Length"]} vs ${r.body.length}`);
ok("缓存头存在", Boolean(r.headers["Cache-Control"]), r.headers["Cache-Control"]);

console.log("\n② 成员头像");
r = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine&agent=prototype-builder");
ok("成员头像 200", r.status === 200, `${r.status} ${r.body.length}B`);
const team = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine");
ok("与整团图不同源", team.body.length !== r.body.length, `整团 ${team.body.length}B / 成员 ${r.body.length}B`);

console.log("\n③ 错误语义");
r = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=__no_such_expert__");
ok("目录外 plugin → 404", r.status === 404, `${r.status} ${r.body.toString().slice(0, 40)}`);
r = await raw("GET", "/dsh-workbuddy-summon/avatar");
ok("缺 plugin → 400", r.status === 400, String(r.status));
r = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=xiaohongshu-operations-expert");
ok("目录内专家头像可取", r.status === 200, `${r.status} ${r.body.length}B`);

console.log("\n④ ETag / 304（换头像不能被长缓存挡住）");
const first = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine&size=64");
const etag = first.headers["ETag"];
ok("ETag 是弱校验 W/\"…\"", typeof etag === "string" && etag.startsWith('W/"'), String(etag));
ok("短缓存 max-age=300", /max-age=300/.test(first.headers["Cache-Control"] ?? ""), first.headers["Cache-Control"]);
const reval = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine&size=64", { "if-none-match": etag });
ok("If-None-Match 命中 → 304 空体", reval.status === 304 && reval.body.length === 0, `${reval.status} ${reval.body.length}B`);
const stale = await raw("GET", "/dsh-workbuddy-summon/avatar?plugin=design-engine&size=64", { "if-none-match": 'W/"deadbeef"' });
ok("ETag 不匹配 → 200 回新图", stale.status === 200 && stale.body.length > 0, `${stale.status} ${stale.body.length}B`);

console.log(fails === 0 ? "\nAVATAR-ROUTE 全部通过：PNG/缓存头/ETag/404 语义" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
