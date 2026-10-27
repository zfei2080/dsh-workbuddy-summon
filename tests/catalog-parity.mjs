/**
 * 目录一致性回归（0.2.0 硬指标）：插件目录 = WorkBuddy 本机专家中心。
 *
 *   node tests/catalog-parity.mjs                 # 正常验收（不一致 → exit 1）
 *   node tests/catalog-parity.mjs --allow-fail    # 只报告不判红（数据层重写完成前用）
 *
 * 断言 loadCatalog({ fresh: false })（完全不联网，只读本机快照/缓存/镜像）与
 * ~/.workbuddy/app/cache/experts/manifest.json（WorkBuddy 专家中心快照）一致：
 *   · entries.length === 448（394 agent + 54 team）
 *   · 条目 id 集合与快照 experts 的 id 集合完全相等（且无重复）
 *   · 分类 id 集合与快照 categories 一致（15 个）
 *   · 不再包含 0.1.1 把本机 marketplaces 扫出来的 9 条噪音
 *   · 每个条目都有 id / plugin / displayName / profession
 *
 * 快照不存在时跳过「与快照逐条比对」并显式标注，其余形状断言照跑。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "../lib/catalog.js";

const allowFail = process.argv.includes("--allow-fail");
const MANIFEST =
	process.env.WB_EXPERT_MANIFEST ?? join(homedir(), ".workbuddy", "app", "cache", "experts", "manifest.json");

/** 0.1.1 的 9 条 bug：本机 marketplaces 里被当成「专家」的包，0.2.0 不允许再出现。 */
const NOISE_IDS = [
	"superpowers-zh",
	"ui-design-team-lead",
	"engineering-director",
	"gaokao-advisor",
	"bazi-master",
	"fortune-consultant",
	"senior-developer",
	"douyin-strategist",
	"ui-designer",
];

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};

/* ── 快照 ── */
let snapshot;
try {
	snapshot = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch {
	snapshot = undefined;
}
console.log(`快照：${MANIFEST}`);
if (snapshot === undefined) {
	console.log("  （未找到本机快照 → 跳过逐条比对，只校验目录自身形状）");
} else {
	console.log(`  ${snapshot.experts.length} 条 / ${snapshot.categories.length} 个分类`);
}

/* ── 目录（离线：fresh:false 不联网） ── */
const t0 = Date.now();
const cat = await loadCatalog({ fresh: false });
const elapsed = Date.now() - t0;
console.log(
	`\n目录：${cat.entries.length} 条 / ${cat.categories.length} 分类（${elapsed}ms）` +
		`｜sources=${cat.sources.map((s) => `${s.name}${s.chosen ? "*" : ""}:${s.origin}`).join(" ")}` +
		`｜degraded=${cat.degraded}`,
);

const snapshotEntries = snapshot?.experts ?? [];
const snapshotIds = new Set(snapshotEntries.map((e) => e.id));
// 内置固化包（packs/）是插件自带资源，不参与「与 WorkBuddy 一致」的口径。
const bundled = cat.entries.filter((e) => e._manifest === "local-pack");
const official = cat.entries.filter((e) => e._manifest !== "local-pack");
const catalogIds = new Set(official.map((e) => e.id));
const allIds = new Set(cat.entries.map((e) => e.id));
const typed = (list) =>
	list.reduce((acc, e) => {
		const k = e.expertType ?? "agent";
		acc[k] = (acc[k] ?? 0) + 1;
		return acc;
	}, {});

/* ── 与 WorkBuddy 专家中心快照逐条比对 ── */
console.log("\n① 与 WorkBuddy 专家中心一致");
if (snapshot !== undefined) {
	ok("官方条目 === 448（另含内置包）", official.length === 448, `官方 ${official.length} + 内置 ${bundled.length} = ${cat.entries.length}`);
	const stats = typed(official);
	ok("expertType 统计 394 agent / 54 team", stats.agent === 394 && stats.team === 54, JSON.stringify(stats));

	const missing = snapshotEntries.map((e) => e.id).filter((id) => !catalogIds.has(id));
	const extra = official.map((e) => e.id).filter((id) => !snapshotIds.has(id));
	ok(
		"id 集合与 manifest 完全相等",
		missing.length === 0 && extra.length === 0,
		`缺 ${missing.length} / 多 ${extra.length}` +
			(missing.length ? ` 缺:${missing.slice(0, 5).join(",")}` : "") +
			(extra.length ? ` 多:${extra.slice(0, 5).join(",")}` : ""),
	);
	ok("id 无重复", allIds.size === cat.entries.length, `${allIds.size} 个唯一 id / ${cat.entries.length} 条`);

	const snapshotCats = new Set(snapshot.categories.map((c) => c.id));
	const catalogCats = new Set(cat.categories.map((c) => c.id));
	const catMissing = [...snapshotCats].filter((id) => !catalogCats.has(id));
	const catExtra = [...catalogCats].filter((id) => !snapshotCats.has(id));
	ok(
		"分类 id 集合一致（15 个）",
		catalogCats.size === snapshotCats.size && catMissing.length === 0 && catExtra.length === 0,
		`目录 ${catalogCats.size} 个` +
			(catMissing.length ? ` 缺:${catMissing.join(",")}` : "") +
			(catExtra.length ? ` 多:${catExtra.join(",")}` : ""),
	);

	ok(
		"res.parity 自检差异为空（只算官方条目）",
		(cat.parity?.missingFromCatalog ?? []).length === 0 && (cat.parity?.extraInCatalog ?? []).length === 0,
		`missing=${(cat.parity?.missingFromCatalog ?? []).length} extra=${(cat.parity?.extraInCatalog ?? []).length} bundled=${cat.parity?.bundledPacks ?? 0}`,
	);
} else {
	ok("快照缺失时目录仍可用（非空、分类非空）", cat.entries.length > 0 && cat.categories.length > 0);
}

/* ── 内置固化包必须在（离线换机时的唯一可用目录） ── */
console.log("\n①-b 内置固化包");
ok("至少有一个内置包", bundled.length > 0, `bundled=${bundled.length}`);
for (const pack of bundled) {
	ok(
		`内置包 ${pack.id} 形状完整`,
		Boolean(pack.plugin) && Boolean(pack.displayName?.zh) && Boolean(pack.profession?.zh) && (pack.expertType === "team" || pack.expertType === "agent"),
		`${pack.expertType} / ${pack.displayName?.zh}`,
	);
}

/* ── 9 条噪音必须绝迹 ── */
console.log("\n② 0.1.1 噪音已绝迹");
const noisy = NOISE_IDS.filter((id) => catalogIds.has(id));
ok("不含 9 条本机市场噪音", noisy.length === 0, noisy.length ? `命中:${noisy.join(",")}` : "0 条");

/* ── 条目形状（UI / 工具直接依赖的原始字段） ── */
console.log("\n③ 条目字段完整");
const displayNameOf = (e) =>
	typeof e.displayName === "string" ? e.displayName : (e.displayName?.zh ?? e.displayName?.en);
const badShape = cat.entries.filter(
	(e) => !e.id || !e.plugin || !String(displayNameOf(e) ?? "").trim() || !e.profession,
);
ok(
	"每条都有 id / plugin / displayName / profession",
	badShape.length === 0,
	badShape.length ? `异常样例:${badShape.slice(0, 5).map((e) => e.id ?? "?").join(",")}` : `${cat.entries.length} 条全齐`,
);

/* ── 结论 ── */
if (fails === 0) {
	console.log(
		`\n== 目录一致性全部通过：官方 ${official.length} 条与 WorkBuddy 专家中心逐条一致，另有 ${bundled.length} 个内置固化包 ==`,
	);
} else if (allowFail) {
	console.log(`\n== ${fails} 项未通过（--allow-fail：本次只报告，不判红）==`);
} else {
	console.error(`\n== ${fails} 项失败 ==`);
	process.exit(1);
}
