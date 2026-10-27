/**
 * 注入文本抽查：把某个专家/专家团的注入段打印出来（默认 design-engine）。
 *
 *   node tests/dump-section.mjs [plugin]
 *
 * 除打印外还做最小断言（防止「能打印但内容坏了」）：
 *   · 注入段非空、含身份标题；
 *   · 专家团含「团队编制与调度规程」与 spawn_teammate；
 *   · 成员定义不整团预注入（省 token 的关键约束）。
 */
import { loadCatalog, loadPackage, entryView } from "../lib/catalog.js";
import { composeSummon } from "../lib/inject.js";

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const wanted = process.argv[2] ?? "design-engine";
const cat = await loadCatalog({ fresh: false });
const raw = cat.entries.find((x) => x.plugin === wanted);
if (raw === undefined) {
	console.error(`✗ 目录里没有 plugin="${wanted}"（共 ${cat.entries.length} 条）`);
	process.exit(1);
}
const view = entryView(raw);
const pkg = await loadPackage(view.plugin, {});
if (pkg?.manifest === undefined) {
	console.error(`✗ 取不到 ${view.plugin} 的包体（网络/缓存问题）`);
	process.exit(1);
}
const text = composeSummon(raw, pkg, { sessionId: "dump-probe", maxLeadChars: 24_000 });

console.log(`plugin=${view.plugin}｜expertType=${view.expertType}｜members=${view.members.length}｜chars=${text.length}`);
ok("注入文本非空", text.length > 500, `${text.length} 字符`);
ok("含身份标题", /^# 本会话已召唤：/.test(text));
ok("含你的定义", text.includes("## 你的定义"));
if (view.expertType === "team") {
	ok("含团队编制与调度规程", text.includes("## 团队编制与调度规程"));
	ok("含 spawn_teammate 调度映射", text.includes("spawn_teammate"));
	ok("成员定义未整团预注入", !/^## 成员定义/m.test(text));
}

const i = text.indexOf("## 团队编制与调度规程");
console.log("\n──────── 注入段节选 ────────");
console.log(i < 0 ? text.slice(-2200) : text.slice(i, i + 2800));
console.log("────────────────────────────");

console.log(fails === 0 ? "\nDUMP-SECTION 通过：注入段可读且关键结构齐全" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
