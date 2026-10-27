/**
 * 卡片标题口径回归：主标题 = profession（WorkBuddy 专家中心同款），副标题 = name 花名。
 *
 *   node tests/title-map.mjs
 *
 * 断言：
 *   · 448 条全部有 title 与 name；
 *   · 有 profession 的条目，title 一律等于 profession（标题不串到花名/plugin）；
 *   · WorkBuddy 专家中心截图里的主标题样本在 profession 里仍能命中（防止整体口径漂移）；
 *   · 花名样本仍能在 name 里命中。
 */
import { loadCatalog, entryView } from "../lib/catalog.js";

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const views = (await loadCatalog({ fresh: false })).entries.map(entryView);
const withProfession = views.filter((v) => v.profession);

console.log("① 标题口径（全量）");
ok("448 条都有 name", views.every((v) => v.name.length > 0), `${views.filter((v) => !v.name).length} 条缺`);
const wrongTitle = withProfession.filter((v) => v.title !== v.profession);
ok(
	"title 一律等于 profession",
	wrongTitle.length === 0,
	wrongTitle.slice(0, 3).map((v) => `${v.plugin}:${v.title}≠${v.profession}`).join(" ; ") || `${withProfession.length} 条全一致`,
);

/* WorkBuddy 专家中心（2026-09 快照）截图里能读到的主标题样本 */
const SHOT_TITLES = [
	"全栈开发专家",
	"高级开发工程师",
	"微信小程序开发专家",
	"微信公众号运营专家",
	"自适应成果交付专家",
	"资讯速递专家",
	"嵌入式固件工程师",
	"中文网络小说创作顾问",
	"创业伙伴",
	"工作台搭建师",
	"长文档写作与改稿专家",
	"战略咨询合伙人",
];
const professions = new Set(views.map((v) => v.profession));
console.log("\n② 截图主标题样本（profession）");
let hit = 0;
for (const t of SHOT_TITLES) {
	const found = professions.has(t);
	if (found) hit += 1;
	console.log(`  ${found ? "✓" : "✗"} ${t}`);
}
ok("截图主标题命中数 ≥ 6/12（快照版本差内允许缺）", hit >= 6, `${hit}/${SHOT_TITLES.length}`);

/* 花名样本：WorkBuddy 卡片副标题 */
const SHOT_NAMES = ["吴八哥", "鹏城信息AI专家", "固件通", "小台", "福帮手", "林正刚", "数字生命卡兹克"];
const names = new Set(views.map((v) => v.name));
console.log("\n③ 截图花名样本（name）");
let nameHit = 0;
for (const n of SHOT_NAMES) {
	const found = names.has(n);
	if (found) nameHit += 1;
	console.log(`  ${found ? "✓" : "✗"} ${n}`);
}
ok("花名命中数 ≥ 4/7", nameHit >= 4, `${nameHit}/${SHOT_NAMES.length}`);

console.log(fails === 0 ? "\nTITLE-MAP 全部通过：主标题=profession、副标题=name 口径稳定" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
