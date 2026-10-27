/**
 * 内置固化专家包（packs/）—— 本地、离线、可随插件搬到其它机器/服务器。
 *
 * 目录结构（沿用 WorkBuddy 专家包格式，便于复用 loadPackage）：
 *   packs/<pack-dir>/ .codebuddy-plugin/plugin.json
 *                    agents/*.md
 *                    skills/<skill>/SKILL.md
 *                    avatars/*.png
 *
 * 与「本机 WorkBuddy 市场包」的区别：这些包**在插件目录里**，换机器时跟着插件走，
 * 不需要安装 WorkBuddy、不需要登录、也不需要联网。
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PACKS_DIR = join(PLUGIN_ROOT, "packs");

/** 官方专家中心 15 个分类的中文名（内置包只用到其中几个，其余留作兜底）。 */
const CATEGORY_NAMES = {
	"01-ProductDesign": "产品设计",
	"02-Engineering": "技术工程",
	"03-GameSpatial": "游戏空间",
	"04-DataAI": "数据智能",
	"05-MarketingGrowth": "营销增长",
	"06-ContentCreative": "内容创作",
	"07-SalesCommerce": "销售商务",
	"08-FinanceInvestment": "金融投资",
	"09-OperationsHR": "运营人力",
	"10-ProjectQuality": "项目质量",
	"11-SecurityCompliance": "法务安全",
	"12-IndustryConsultant": "行业顾问",
	"13-TencentZone": "腾讯专区",
	"14-GlobalDevelopment": "全球发展",
	"15-BackToSchool": "开学季",
	"18-Double11": "双十一",
};

let scanCache = null; // { at, entries, roots }
const SCAN_TTL_MS = 60_000;

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

function scanPacks() {
	if (scanCache !== null && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache;
	const entries = [];
	const roots = new Map();
	let dirs = [];
	try {
		dirs = readdirSync(PACKS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		/* 没有 packs 目录 = 未内置任何包 */
	}
	for (const dir of dirs) {
		const root = join(PACKS_DIR, dir);
		const manifestPath = join(root, ".codebuddy-plugin", "plugin.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = readJson(manifestPath);
		if (manifest === undefined) continue;
		const plugin = typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : dir;
		const expertType = manifest.expertType === "team" ? "team" : "agent";
		const categoryId = typeof manifest.categoryId === "string" ? manifest.categoryId : undefined;
		const members = Array.isArray(manifest.members) ? manifest.members : [];
		entries.push({
			...manifest,
			id: plugin,
			plugin,
			expertType,
			displayName: manifest.displayName ?? { zh: plugin, en: plugin },
			profession: manifest.profession ?? { zh: "", en: "" },
			description: manifest.displayDescription ?? manifest.description ?? { zh: "", en: "" },
			avatar: typeof manifest.avatar === "string" ? manifest.avatar : undefined,
			categoryId,
			categoryName: categoryId === undefined ? undefined : { zh: CATEGORY_NAMES[categoryId] ?? categoryId, en: CATEGORY_NAMES[categoryId] ?? categoryId },
			tags: Array.isArray(manifest.tags) ? manifest.tags : [],
			defaultInitPrompt: manifest.defaultInitPrompt ?? { zh: "", en: "" },
			quickPrompts: Array.isArray(manifest.quickPrompts) ? manifest.quickPrompts : [],
			members,
			agentName: manifest.agentName,
			teamInfo: manifest.teamInfo,
			agents: Array.isArray(manifest.agents) ? manifest.agents : [],
			skills: Array.isArray(manifest.skills) ? manifest.skills : [],
			_manifest: "local-pack",
			_localRoot: root,
			_bundled: true,
		});
		roots.set(plugin, root);
	}
	scanCache = { at: Date.now(), entries, roots };
	return scanCache;
}

/** 内置包目录条目（供目录合并用）。 */
export function localPackEntries() {
	return scanPacks().entries;
}

/** plugin → 包根目录（供 loadPackage 读取本地文件）。 */
export function localPackRoots() {
	return scanPacks().roots;
}

/** 某个内置包的磁盘占用（诊断/README 用）。 */
export function packSizeBytes() {
	let total = 0;
	const walk = (dir) => {
		let ents = [];
		try {
			ents = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of ents) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else {
				try {
					total += statSync(p).size;
				} catch {
					/* 忽略 */
				}
			}
		}
	};
	walk(PACKS_DIR);
	return total;
}
