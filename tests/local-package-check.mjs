/**
 * 本机市场包的边界回归（0.1.1 的 457 条 bug 直接相关）。
 *
 *   node tests/local-package-check.mjs
 *
 * 0.2.0 的目录口径 = WorkBuddy 专家中心清单；`~/.workbuddy/plugins/marketplaces`
 * 里扫出来的本机包**不再进目录条目**，只作为 `loadPackage()` 的内容兜底。
 * 本用例断言：
 *   · 本机市场包（本机有、云端快照没有的）一条都不出现在目录里；
 *   · 这些包仍能被 `loadPackage({offlineOnly:true})` 从本机目录读到正文（兜底没坏）；
 *   · 目录条数仍等于快照条数（448）而不是 448 + 本机包数。
 * 本机没有市场包时打印 SKIP 并以 0 退出（云端 CI 环境）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCatalog, loadPackage, localMarketplaceEntries } from "../lib/catalog.js";

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const MANIFEST = join(homedir(), ".workbuddy", "app", "cache", "experts", "manifest.json");
let snapshot;
try {
	snapshot = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch {
	snapshot = undefined;
}

const cat = await loadCatalog({ fresh: false });
const catalogPlugins = new Set(cat.entries.map((e) => e.plugin));
const catalogIds = new Set(cat.entries.map((e) => e.id));
console.log(`目录 ${cat.entries.length} 条 / ${catalogPlugins.size} 个 plugin`);

const locals = localMarketplaceEntries();
console.log(`本机市场专家包 ${locals.length} 个`);
if (locals.length === 0) {
	console.log("  SKIP：本机没有市场包，跳过 457 条回归（云端/干净环境属正常）");
} else {
	const snapshotPlugins = new Set((snapshot?.experts ?? []).map((e) => e.plugin));
	// 本机有、快照没有 → 这些包绝不允许进目录（0.1.1 就是它们把 448 变成了 457）
	const localOnly = locals.filter((e) => !snapshotPlugins.has(e.plugin));
	const leaked = localOnly.filter((e) => catalogPlugins.has(e.plugin));
	ok(
		"本机市场包没有混进目录（0.1.1 的 457 条 bug）",
		leaked.length === 0,
		leaked.length ? `泄漏:${leaked.map((e) => e.plugin).join(",")}` : `${localOnly.length} 个本机包全部只在兜底层`,
	);

	if (snapshot !== undefined) {
		// 内置固化包（packs/）是插件自带资源，按设计会进目录；官方条目数仍须等于快照。
		const officialCount = cat.entries.filter((e) => e._manifest !== "local-pack").length;
		const bundledCount = cat.entries.length - officialCount;
		ok(
			"官方条目数 = 快照条数（内置包另计，不是 448 + 本机包数）",
			officialCount === snapshot.experts.length,
			`官方 ${officialCount} + 内置 ${bundledCount} / 快照 ${snapshot.experts.length}`,
		);
		const noise = localOnly.map((e) => e.plugin).filter((p) => catalogIds.has(p));
		ok("本机包 id 未出现在目录 id 集合", noise.length === 0, noise.join(",") || "0 条");
	}

	// 兜底能力：本机包不进目录，但 loadPackage 仍要能从它自己的目录读到正文
	console.log("\n本机包内容兜底（离线读本机目录）：");
	let readable = 0;
	for (const e of locals) {
		const pkg = await loadPackage(e.plugin, { offlineOnly: true, noBundle: true });
		const good = pkg?.manifest !== undefined && (pkg.agentNames?.length ?? 0) > 0;
		if (good) readable += 1;
		console.log(`  ${good ? "✓" : "✗"} ${e.plugin} → manifest=${Boolean(pkg?.manifest)} agents=${pkg?.agentNames?.length ?? 0} skills=${pkg?.skills?.length ?? 0}`);
	}
	ok("所有本机包都能离线读到正文", readable === locals.length, `${readable}/${locals.length}`);
}

console.log(fails === 0 ? "\nLOCAL-PACKAGE 全部通过：本机包只做兜底、不进目录" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
