/**
 * 长文本分页 / 分层细节取用回归（wb_expert_read）。
 *
 *   node tests/paging-check.mjs
 *
 * 用假 ctx 跑 apply()（maxReadChars 压到 3000，逼出多段续读）：
 *   · 包清单给出 lead / agents / skills + references；
 *   · 技能正文分段返回，按 nextFrom 续读能拼回完整正文（总长 = totalChars）；
 *   · ref 分层细节可取、不存在的 ref 回清单、路径穿越被拒；
 *   · 成员定义按需取（不整团预注入的配套能力）。
 */
import { EventEmitter } from "node:events";

let fails = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) fails += 1;
	console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const calls = { tools: [] };
const ctx = {
	effect: (f) => {
		const d = f();
		return typeof d === "function" ? d : () => {};
	},
	on: () => () => {},
	systemPrompt: { section: () => () => {} },
	tools: { register: (d) => { calls.tools.push(d); return () => {}; } },
	webServer: { register: () => () => {} },
	agents: { currentInitiator: () => ({ sessionId: "pg" }) },
	logger: { info() {}, warn() {} },
};
const m = await import("../index.js");
await m.apply(ctx, { warmCatalog: false, maxReadChars: 3000 });
const read = calls.tools.find((t) => t.name === "wb_expert_read");
ok("wb_expert_read 已注册", typeof read?.execute === "function");

const PLUGIN = "content-creator";

console.log("\n① 包清单");
const list = await read.execute({ plugin: PLUGIN });
ok("清单给出 agents / skills", (list.agents?.length ?? 0) > 0 && (list.skills?.length ?? 0) > 0, `agents=${list.agents?.length} skills=${list.skills?.length}`);
const sk = list.skills.find((s) => (s.references?.length ?? 0) >= 4) ?? list.skills[0];
ok("存在带分层细节的技能", (sk.references?.length ?? 0) >= 4, `${sk.name} refs=${sk.references?.length}`);

console.log("\n② 技能正文分页：必须分段且能续读完");
let from;
let total = 0;
let pages = 0;
let guard = 0;
for (;;) {
	const r = await read.execute({ plugin: PLUGIN, skill: sk.name, ...(from ? { from } : {}) });
	if (r.error !== undefined) {
		ok(`技能正文可读（${sk.name}）`, false, r.error);
		break;
	}
	pages += 1;
	total += r.text.length;
	if (r.nextFrom === null || r.nextFrom === undefined) {
		ok("多段续读（cap=3000 时应 >1 段）", pages > 1, `${pages} 段`);
		ok("续读拼回完整正文", total === r.totalChars, `${total}/${r.totalChars} 字符`);
		ok("末段 truncated=false", r.truncated === false);
		break;
	}
	from = r.nextFrom;
	if (++guard > 20) { ok("续读收敛", false, "超过 20 段仍未结束"); break; }
}

console.log("\n③ 分层细节（ref）");
const ref = await read.execute({ plugin: PLUGIN, skill: sk.name, ref: sk.references[3] });
ok(`ref=${sk.references[3]} 可取`, (ref.text?.length ?? 0) > 0, `${ref.text?.length ?? 0} 字符`);
const badRef = await read.execute({ plugin: PLUGIN, skill: sk.name, ref: "references/查无此文件.md" });
ok("不存在的 ref → error + 可用清单", Boolean(badRef.error) && (badRef.available?.length ?? 0) > 0, `available=${badRef.available?.length}`);
const traversal = await read.execute({ plugin: PLUGIN, skill: sk.name, ref: "../../../etc/passwd" });
ok("路径穿越被拒", traversal.text === undefined);

console.log("\n④ 成员定义按需读");
const mem = await read.execute({ plugin: "design-engine", agent: "prototype-builder" });
ok("成员正文可取", (mem.text?.length ?? 0) > 0, `${mem.text?.length ?? 0} 字符`);
const badAgent = await read.execute({ plugin: "design-engine", agent: "查无此人" });
ok("不存在的成员 → error + 成员清单", Boolean(badAgent.error) && (badAgent.available?.length ?? 0) > 0, `available=${badAgent.available?.length}`);

console.log(fails === 0 ? "\nPAGING 全部通过：分段续读 / ref 取用 / 成员按需读" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
