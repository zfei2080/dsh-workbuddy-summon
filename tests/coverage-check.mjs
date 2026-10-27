/**
 * 目录字段覆盖率：448 条条目里，UI / 工具直接依赖的字段是否齐全、分类是否解析。
 *
 *   node tests/coverage-check.mjs
 *
 * 断言（全量，不抽样）：
 *   · 448 条、15 个分类；
 *   · id / plugin / title / name / profession / description / category / avatar 全部非空；
 *   · categoryId 全部落在目录 categories 里，且 category 已解析成中文名（不是 id）；
 *   · 54 个专家团都有成员（memberCount > 0）且成员头像齐全；
 *   · 394 个单专家 memberCount === 0。
 */
import { loadCatalog, entryView } from "../lib/catalog.js";

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const cat = await loadCatalog({ fresh: false });
const views = cat.entries.map(entryView);
const categories = new Map(cat.categories.map((c) => [c.id, c.name]));
console.log(`目录 ${views.length} 条 / ${categories.size} 个分类`);

const missing = (field) => views.filter((v) => v[field] === undefined || v[field] === null || v[field] === "");
console.log("\n① 基础字段非空（全量）");
for (const field of ["id", "plugin", "title", "name", "profession", "description", "category", "avatar"]) {
	const bad = missing(field);
	ok(
		`${field} 齐全`,
		bad.length === 0,
		bad.length ? `缺 ${bad.length} 条，例:${bad.slice(0, 3).map((v) => v.plugin).join(",")}` : `${views.length}/${views.length}`,
	);
}

console.log("\n② 分类解析");
const badCat = views.filter((v) => !categories.has(v.categoryId));
ok(
	"categoryId 全在目录分类里",
	badCat.length === 0,
	badCat.length ? badCat.slice(0, 3).map((v) => v.categoryId).join(",") : "0 条越界",
);
const rawCat = views.filter((v) => v.category === v.categoryId || v.category === "");
ok(
	"category 已解析成中文名（不是 id）",
	rawCat.length === 0,
	rawCat.length ? rawCat.slice(0, 3).map((v) => v.categoryId).join(",") : "0 条未解析",
);

console.log("\n③ 专家团 / 单专家形状");
const teams = views.filter((v) => v.expertType === "team");
const experts = views.filter((v) => v.expertType !== "team");
// 内置固化包（local-pack）不参与「官方 448」口径，单独计数。
const bundled = views.filter((v) => v.manifest === "local-pack");
const officialTeams = teams.filter((v) => v.manifest !== "local-pack");
const officialExperts = experts.filter((v) => v.manifest !== "local-pack");
ok("官方专家团 54 个", officialTeams.length === 54, `${officialTeams.length}（另有内置包 ${bundled.length} 个）`);
ok("官方单专家 394 个", officialExperts.length === 394, String(officialExperts.length));
ok("内置固化包可见", bundled.length >= 1, `${bundled.length} 个`);
const emptyTeam = teams.filter((v) => v.memberCount === 0);
ok("每个专家团都有成员", emptyTeam.length === 0, emptyTeam.map((v) => v.plugin).join(",") || "0 个空团");
const noAvatarMember = teams.filter((v) => !v.members.every((m) => m.avatar));
ok(
	"专家团成员头像齐全",
	noAvatarMember.length === 0,
	noAvatarMember.map((v) => v.plugin).join(",") || `${teams.reduce((n, v) => n + v.members.length, 0)} 个成员全带头像`,
);
const expertWithMembers = experts.filter((v) => v.memberCount !== 0);
ok(
	"单专家 memberCount 为 0",
	expertWithMembers.length === 0,
	expertWithMembers.map((v) => v.plugin).join(",") || "0 个异常",
);

console.log(fails === 0 ? "\nCOVERAGE 全部通过：448 条字段/分类/团形状全量覆盖" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
