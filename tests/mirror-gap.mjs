/**
 * 本机镜像 / 本机市场包与目录的差异观察（诊断型用例，只报告不判红）。
 *
 *   node tests/mirror-gap.mjs
 *
 * 用途：排查「某个包在 WorkBuddy 装过、但插件目录里没有」这类问题。
 * 0.2.0 起本机市场包**不再进目录**（只做 loadPackage 内容兜底），所以这里看的是：
 *   · 本机镜像 remote/ 里有、目录清单里没有的 plugin（镜像比清单新/多的部分）；
 *   · 本机市场里已下载的专家包（诊断索引，不参与目录）。
 * 判定：目录能加载且非空即通过；差异条数只观察。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadCatalog, MIRROR_ROOT, localMarketplaceEntries } from "../lib/catalog.js";

const cat = await loadCatalog({ fresh: false });
const plugins = new Set(cat.entries.map((e) => e.plugin));
console.log(`目录 ${cat.entries.length} 条 / ${plugins.size} 个 plugin｜degraded=${cat.degraded}`);
if (cat.entries.length === 0) {
	console.error("✗ 目录为空 —— 数据层不可用");
	process.exit(1);
}

const remoteDir = join(MIRROR_ROOT, "remote");
if (existsSync(remoteDir)) {
	const mirrored = readdirSync(remoteDir);
	const gap = mirrored.filter((p) => !plugins.has(p));
	console.log(`本机镜像 ${mirrored.length} 个包｜镜像有而目录无 ${gap.length} 个`);
	console.log(`  样例：${gap.slice(0, 8).join(", ") || "（无）"}`);
} else {
	console.log(`本机镜像不存在（${remoteDir}），跳过镜像差异观察`);
}

const locals = localMarketplaceEntries();
console.log(`本机市场已下载专家包 ${locals.length} 个（诊断索引，0.2.0 起不进目录）`);
if (locals.length > 0) {
	const inCatalog = locals.filter((e) => plugins.has(e.plugin));
	console.log(`  其中同时出现在目录里的 plugin：${inCatalog.length} 个（正常：目录按清单，不按本机扫描）`);
}

console.log("\n（观察型用例：只报告差异，不作为失败判定）");
