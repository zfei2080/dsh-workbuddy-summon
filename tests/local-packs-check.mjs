/**
 * 内置固化专家包回归（0.4.0）。
 *
 * 断言：packs/ 里的「全域智囊团」在**完全离线**（fresh:false、offlineOnly）时可被目录发现、
 * 可被 loadPackage 读取、可生成包含全部 15 名成员编制的注入段 —— 换机器/上服务器不依赖 WorkBuddy。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, loadPackage, entryView } from "../lib/catalog.js";
import { composeSummon } from "../lib/inject.js";
import { PACKS_DIR, localPackEntries } from "../lib/locals.js";

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const PACK_PLUGIN = "all-domain-brain-trust";
const MEMBERS = [
	"litigation-legal",
	"ask-liuxiaopai",
	"smb-finance",
	"chaogeek-kongming",
	"ui-designer",
	"jwb-monthly-diagnosis-expert",
	"k12-education",
	"therapy-board-expert",
	"behavioral-psychology-expert",
	"jwb-sales-consultant-expert",
	"software-team-lead",
	"software-product-manager",
	"software-architect",
	"software-engineer",
	"software-qa-engineer",
];

console.log(`packs 目录：${PACKS_DIR}`);
const discovered = localPackEntries();
ok("packs 目录里发现内置包", discovered.length >= 1, `${discovered.length} 个`);
const pack = discovered.find((p) => p.plugin === PACK_PLUGIN);
ok(`内置包 ${PACK_PLUGIN} 存在`, pack !== undefined);

if (pack !== undefined) {
	const root = join(PACKS_DIR, PACK_PLUGIN);
	const manifest = JSON.parse(readFileSync(join(root, ".codebuddy-plugin", "plugin.json"), "utf8"));
	ok("expertType = team", manifest.expertType === "team", manifest.expertType);
	ok("主理人 = brain-trust-lead", manifest.agentName === "brain-trust-lead", manifest.agentName);
	ok("成员清单 15 人", (manifest.teamInfo?.memberAgents ?? []).length === 15, `${(manifest.teamInfo?.memberAgents ?? []).length} 人`);
	ok("members 记录 16 条（含主理人）", (manifest.members ?? []).length === 16, `${(manifest.members ?? []).length} 条`);

	const missingAgents = MEMBERS.filter((id) => !existsSync(join(root, "agents", `${id}.md`)));
	ok("15 名成员的 agent 定义都在本地", missingAgents.length === 0, missingAgents.length ? `缺:${missingAgents.join(",")}` : "齐全");
	ok("主理人 agent 定义在本地", existsSync(join(root, "agents", "brain-trust-lead.md")));
	ok("技能数量 >= 10", (manifest.skills ?? []).length >= 10, `${(manifest.skills ?? []).length} 个`);
	ok("团队头像存在", existsSync(join(root, String(manifest.avatar ?? ""))), manifest.avatar);
	const missingAvatars = (manifest.members ?? []).filter((m) => !existsSync(join(root, String(m.avatar ?? ""))));
	ok("16 个成员头像都在本地", missingAvatars.length === 0, missingAvatars.length ? `缺:${missingAvatars.map((m) => m.id).join(",")}` : "16/16");

	// 目录（离线）里能看到它
	const cat = await loadCatalog({ fresh: false });
	const entry = cat.entries.find((e) => e.plugin === PACK_PLUGIN);
	ok("离线目录包含内置包", entry !== undefined, `目录 ${cat.entries.length} 条`);
	if (entry !== undefined) {
		const view = entryView(entry);
		ok("entryView 标题/名称正确", view.title.length > 0 && view.name === "全域智囊团", `${view.title} / ${view.name}`);
		ok("entryView 成员数 = 15", view.memberCount === 15, String(view.memberCount));
		ok("entryView 分类 = 行业顾问", view.category === "行业顾问", String(view.category));

		// 离线读包 + 注入段
		const pkg = await loadPackage(PACK_PLUGIN, { offlineOnly: true, noBundle: true });
		ok("loadPackage 离线成功", pkg?.manifest !== undefined);
		ok("读到 16 个 agent", (pkg?.agentNames ?? []).length === 16, `${(pkg?.agentNames ?? []).length} 个`);
		ok("读到 15 个技能", (pkg?.skills ?? []).length === 15, `${(pkg?.skills ?? []).length} 个`);

		const section = composeSummon(entry, pkg, { maxLeadChars: 24000 });
		ok("注入段非空", section.length > 3000, `${section.length} 字符`);
		const missingInSection = MEMBERS.filter((id) => !section.includes(id));
		ok("注入段包含全部 15 名成员", missingInSection.length === 0, missingInSection.length ? `缺:${missingInSection.join(",")}` : "15/15");
		ok("注入段含调度映射（spawn_teammate）", section.includes("spawn_teammate"));
		ok("注入段含成员正文取用提示（wb_expert_read）", section.includes("wb_expert_read"));
	}
}

if (fails === 0) {
	console.log("\n== 内置固化专家包全部通过：离线可发现 / 可读包 / 可生成 15 人编制注入段 ==");
} else {
	console.error(`\n== ${fails} 项失败 ==`);
	process.exit(1);
}
