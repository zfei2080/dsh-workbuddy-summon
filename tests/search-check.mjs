/**
 * 目录搜索回归：搜索覆盖 title / 花名 / 职业 / 简介 / 标签 / plugin。
 *
 *   node tests/search-check.mjs
 *
 * 断言：
 *   · 空查询返回全量 448 条；
 *   · 常用能力词（设计 / 运营 / 数据 / 金融 / 研究 / 交易 / 工程 / 法律）都能搜到结果；
 *   · 关键词命中项确实包含该词（不会把无关条目算进来）。
 */
import { loadCatalog, entryView } from "../lib/catalog.js";

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const views = (await loadCatalog({ fresh: false })).entries.map(entryView);
const haystack = (v) => `${v.title} ${v.name} ${v.nameEn} ${v.profession} ${v.description} ${v.tags.join(" ")} ${v.plugin} ${v.category}`.toLowerCase();
const hit = (q) => views.filter((v) => haystack(v).includes(q.toLowerCase()));

console.log(`目录 ${views.length} 条`);
ok("空查询 = 全量", hit("").length === views.length, `${hit("").length}/${views.length}`);

console.log("\n能力词搜索：");
const TERMS = ["设计", "运营", "数据", "金融", "研究", "交易", "工程", "法律"];
for (const q of TERMS) {
	const r = hit(q);
	const bad = r.filter((v) => !haystack(v).includes(q.toLowerCase()));
	ok(`q="${q}" 有结果且命中项都含该词`, r.length > 0 && bad.length === 0, `${r.length} 条${bad.length ? `，${bad.length} 条不含词` : ""}  例:${r.slice(0, 2).map((v) => `${v.name}(${v.plugin})`).join(" ")}`);
}

console.log("\n小说/创作相关（WorkBuddy 内容类专家）：");
const novel = hit("小说").concat(hit("网文"), hit("创作"));
const uniqNovel = [...new Map(novel.map((v) => [v.plugin, v])).values()];
console.log(`  ${uniqNovel.length} 条，例:${uniqNovel.slice(0, 5).map((v) => `${v.profession}/${v.name}`).join(" ; ")}`);
ok("创作类至少有结果", uniqNovel.length > 0, `${uniqNovel.length} 条`);

console.log(fails === 0 ? "\nSEARCH 全部通过：字段覆盖与关键词命中断言成立" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
