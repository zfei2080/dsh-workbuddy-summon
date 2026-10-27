/**
 * 零连接器回归（0.2.0 硬指标）：仓库里不再有连接器实现 / 工具 / 路由 / 配置 / 文案。
 *
 *   node tests/no-connector-check.mjs
 *
 * 扫描范围：index.js、lib/*.js、tests/*.mjs（跳过本文件）、README.md、
 * locale/*.json、package.json、cordis.patch.yml。
 *
 * 断言：
 *   · 连接器模块文件与用例文件已不存在（lib/connectors.js 等）；
 *   · 除「说明性移除句子」白名单外，任何 connector / 连接器 字样 0 命中；
 *   · 工具名 / 路由 / config 配置构造 0 命中；
 *   · package.json 与 locale 的 JSON key 里没有连接器键；两语种 locale key 同构；
 *   · 保留能力仍在（index.js 里 4 个工具名齐全），防止「扫了个空文件」式假通过。
 *
 * 白名单（精确按句 / 按行，且必须命中一次，防止白名单过期）：
 *   · README.md：6 行「已移除」说明（引言 1 行 + 硬指标表 1 行 + 移除章节 3 行 + 测试表 1 行）；
 *   · package.json：description 里的 `0.2.0 起已移除连接器功能。`；
 *   · cordis.patch.yml：注释行 `# 0.2.0 起连接器功能已整体移除，不再有 connectors.* 配置项。`。
 *
 * 0.3.0 跟进：在线市场新增了 lib/market.js、index.js 的 wb_market_* 工具 / /market/* 路由、
 * lib/client.js 的「市场」tab 与 .wbsum-market-* 样式。这些文件本来就在扫描集里
 * （lib/*.js、tests/*.mjs 全量递归），⑥ 额外做「确实扫到了新文件 + 新能力仍在」的显式断言，
 * 防止有人把扫描集缩窄后出现假绿。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = "tests/no-connector-check.mjs";

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};

/* ── 白名单：只允许「已移除」说明性句子 ── */
const ALLOW = {
	"README.md": [
		"> **0.2.0 起已彻底移除连接器（Connector）**：不再有连接器工具、路由、面板 tab 与 `connectors.*` 配置；只保留专家 / 专家团目录与召唤。",
		"| 彻底删除连接器 | 无连接器模块 / 工具 / 路由 / 面板 tab / 配置项 | `node tests/no-connector-check.mjs` |",
		"## 连接器已移除（0.2.0）",
		"0.2.0 起已彻底移除连接器（Connector）：`wb_connectors_*` / `wb_local_connectors_*` 四个工具、`/connectors` 与 `/connector-*` / `/local-connector*` 路由、面板的连接器 / 本地 tab、以及 `cordis.patch.yml` 里的 `connectors.*` 配置项全部删除；本版只保留专家 / 专家团目录与召唤。",
		"0.1.1 留下的 `session-connectors.json` 与 `connector-probe-cache.json` 不再读取，可手动删除。",
		"| `tests/no-connector-check.mjs` | 连接器实现 / 工具 / 路由 / 配置 / 文案零残留（含白名单） | 离线 |",
	],
	"package.json": ["0.2.0 起已移除连接器功能。"],
	"cordis.patch.yml": ["# 0.2.0 起连接器功能已整体移除，不再有 connectors.* 配置项。"],
};

const raw = /connector|连接器/i;

/* ── 文件清单 ── */
function walk(dir, exts) {
	const out = [];
	let entries;
	try {
		entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
		if (entry.isDirectory()) out.push(...walk(rel, exts));
		else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(rel);
	}
	return out;
}

const FILES = [
	"index.js",
	...walk("lib", [".js"]),
	...walk("tests", [".mjs"]).filter((f) => f !== SELF),
	"README.md",
	...walk("locale", [".json"]),
	"package.json",
	"cordis.patch.yml",
];

/* ── ① 连接器模块 / 用例文件必须已删除 ── */
console.log("① 连接器模块与用例文件已删除");
const REMOVED_FILES = [
	"lib/connectors.js",
	"lib/local-connectors.js",
	"lib/connector-probe.js",
	"lib/connector-session.js",
	"tests/connector-route-check.mjs",
	"tests/connector-name-check.mjs",
	"tests/conn-scan.mjs",
	"tests/local-connectors-check.mjs",
];
for (const f of REMOVED_FILES) ok(`${f} 不存在`, !existsSync(join(ROOT, f)));
const badTestNames = walk("tests", [".mjs"]).filter((f) => f !== SELF && /connector/i.test(f));
ok("tests/ 下没有连接器命名的用例", badTestNames.length === 0, badTestNames.join(",") || "0 个");

/* ── ② 白名单精确放行 + 残留扫描 ── */
console.log("\n② 白名单之外 0 命中（connector / 连接器）");
const residual = new Map(); // rel → text after whitelist
for (const rel of FILES) {
	const full = join(ROOT, rel);
	if (!existsSync(full)) {
		ok(`${rel} 存在`, false, "扫描目标缺失");
		continue;
	}
	let text = readFileSync(full, "utf8");
	for (const snippet of ALLOW[rel] ?? []) {
		const count = text.split(snippet).length - 1;
		ok(`白名单命中 ${rel}：${snippet.slice(0, 24)}…`, count >= 1, `${count} 次`);
		if (count >= 1) text = text.split(snippet).join("");
	}
	residual.set(rel, text);
}
const scanned = [...residual.keys()];
const hits = [];
for (const [rel, text] of residual) {
	text.split(/\r?\n/).forEach((line, i) => {
		if (raw.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
	});
}
ok(`扫描 ${scanned.length} 个文件后无残留`, hits.length === 0, hits.slice(0, 5).join(" ｜ ") || "0 处");

/* ── ③ 工具 / 路由 / 配置构造断言（给出明确类别） ── */
console.log("\n③ 连接器工具 / 路由 / 配置构造 0 命中");
const CONSTRUCTS = [
	["工具名（wb_connectors_* / wb_local_connectors_*）", /\bwb_(?:local_)?connectors?_(?:list|install|manage)\b/],
	["路由（/connectors、/connector-*、/local-connector*）", /\/connectors\b|\/connector-(?:probe|install|remove|add|update)\b|\/local-connector/],
	["配置项（connectors.* / cfg.connectors）", /\bconnectors\s*[:.=]|\bcfg\.connectors\b|\bconfig\.connectors\b/],
	["模块引用（connectors.js / connector-probe / connector-session）", /connector-(?:probe|session)|local-connectors\.js|connectors\.js/],
	["面板/API 标识（apiConnectors / doConnector / tabConn …）", /\bapiConnectors\b|\bdoConnector\b|\bisConnector\b|\btabConn\b|\bconnBlocked\b/],
	["connector 前缀标识符（connectorId / connectorName …）", /\bconnector[A-Z]\w*/],
];
for (const [label, re] of CONSTRUCTS) {
	const found = [];
	for (const [rel, text] of residual) if (re.test(text)) found.push(rel);
	ok(label, found.length === 0, found.join(",") || "0 命中");
}

/* ── ④ JSON 结构：没有连接器 key；locale 两语种同构 ── */
console.log("\n④ JSON 结构");
function keyPaths(value, prefix = [], out = []) {
	if (Array.isArray(value) || value === null || typeof value !== "object") return out;
	for (const [k, v] of Object.entries(value)) {
		const p = [...prefix, k];
		out.push(p.join("."));
		keyPaths(v, p, out);
	}
	return out;
}
const jsonFiles = [...walk("locale", [".json"]), "package.json"];
for (const rel of jsonFiles) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
	} catch (error) {
		ok(`${rel} 是合法 JSON`, false, String(error?.message ?? error));
		continue;
	}
	const badKeys = keyPaths(parsed).filter((p) => /connector/i.test(p));
	ok(`${rel} 无连接器 key`, badKeys.length === 0, badKeys.join(",") || "0 个");
}
const en = JSON.parse(readFileSync(join(ROOT, "locale/en.json"), "utf8"));
const zh = JSON.parse(readFileSync(join(ROOT, "locale/zh.json"), "utf8"));
const enKeys = keyPaths(en).sort();
const zhKeys = keyPaths(zh).sort();
ok("locale en/zh key 同构", JSON.stringify(enKeys) === JSON.stringify(zhKeys), `en=${enKeys.join("|")} zh=${zhKeys.join("|")}`);

/* ── ⑤ 保留能力仍在（防假通过） ── */
console.log("\n⑤ 保留能力仍在");
const indexSrc = readFileSync(join(ROOT, "index.js"), "utf8");
for (const tool of ["wb_experts_list", "wb_expert_read", "wb_summon", "wb_unsummon"]) {
	ok(`index.js 仍注册 ${tool}`, new RegExp(`name:\\s*"${tool}"`).test(indexSrc));
}
ok("index.js 仍有 HTTP 路由注册", /webServer\.register\(\{\s*kind:\s*"prefix"/.test(indexSrc));

/* ── ⑥ 0.3.0 新增能力 + 扫描集确实覆盖新文件（防缩窄扫描集后的假绿） ── */
console.log("\n⑥ 0.3.0 在线市场文件已在扫描集内，新能力仍在");
const REQUIRED_SCANNED = [
	"index.js",
	"lib/market.js",
	"lib/client.js",
	"tests/market-check.mjs",
	"tests/market-unit.mjs",
	"README.md",
];
for (const rel of REQUIRED_SCANNED) {
	ok(`${rel} 在扫描集内`, scanned.includes(rel));
}
const marketSrc = residual.get("lib/market.js") ?? "";
ok("lib/market.js 确实被扫到（marketSearch 命中）", /export async function marketSearch/.test(marketSrc));
const clientSrc = residual.get("lib/client.js") ?? "";
ok(
	"lib/client.js 的市场 UI 确实被扫到（.wbsum-market-connect 命中）",
	/\.wbsum-market-connect/.test(clientSrc) && /const TAB_ORDER = \["team", "expert", "market"\]/.test(clientSrc),
);
for (const tool of ["wb_market_search", "wb_market_capture"]) {
	ok(`index.js 仍注册 ${tool}`, new RegExp(`name:\\s*"${tool}"`).test(indexSrc));
}
ok("市场工具受 cfg.market.enabled 开关控制", /cfg\.market\?\.enabled !== false/.test(indexSrc));
for (const route of ["market/status", "market/categories", "market/search", "market/capture"]) {
	ok(`index.js 仍有 /${route} 路由`, indexSrc.includes(`seg === "${route}"`));
}
ok("头像路由支持市场绝对 URL（?src=）", /seg === "avatar"/.test(indexSrc) && indexSrc.includes('url.searchParams.get("src")'));

/* ── 结论 ── */
const pass = fails === 0;
console.log(
	pass
		? `\nNO-CONNECTOR 全部通过：扫描 ${scanned.length} 个文件（含 0.3.0 的 lib/market.js 与市场 UI），白名单 ${Object.values(ALLOW).flat().length} 句，连接器实现/工具/路由/配置 0 命中`
		: `\n失败 ${fails} 项`,
);
process.exit(pass ? 0 : 1);
