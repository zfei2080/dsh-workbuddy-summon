/**
 * 「切 tab / 搜索不闪」的策略回归 —— 直接测纯函数 listSeed（client.js 模块级），
 * 不用 mock React：策略本身可测，就不该靠猜渲染。
 *   node tests/tab-switch-check.mjs
 *
 * 契约：切 tab → { seed } 必为缓存值或 null（绝不 undefined，即绝不留着旧 tab 的列表）；
 *       同 tab 内改查询 → seed === undefined（= 不动列表）。
 */
import { readFileSync } from "node:fs";

let fails = 0;
const ok = (label, cond, extra = "") => { if (!cond) fails += 1; console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`); };

/* 从源码里取出 listSeed 并求值 —— 它是纯函数，无外部依赖 */
const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const at = src.indexOf("function listSeed(");
if (at < 0) { console.log("✗ 源码里找不到 listSeed"); process.exit(1); }
const body = src.slice(at, src.indexOf("\n\t\t\t}", at) + 5);
const listSeed = new Function(`${body}; return listSeed;`)();
ok("listSeed 可独立求值（纯函数，无闭包依赖）", typeof listSeed === "function");

const CACHE = new Map([["team||", { items: [1], total: 1 }]]);

/* ① 切到没看过的 tab：必须 seed = null（进骨架态），绝不能是 undefined */
{
	const r = listSeed(CACHE, "team", "expert", "expert||");
	ok("切到没看过的 tab → seed=null（清空进骨架态）", r.seed === null, `seed=${JSON.stringify(r.seed)}`);
	ok("  · 且 switched=true", r.switched === true && r.cached === undefined);
}
/* ② 切到看过的 tab：seed = 缓存对象（立即出内容，不清空） */
{
	const cache = new Map(CACHE);
	cache.set("expert||", { items: [9], total: 1 });
	const r = listSeed(cache, "team", "expert", "expert||");
	ok("切回看过的 tab → seed=缓存（不清空，直接渲染）", r.seed === cache.get("expert||"));
}
/* ③ 同一 tab 内改搜索词：seed = undefined（保留旧列表，不闪） */
{
	const r = listSeed(CACHE, "team", "team", "team|novel|");
	ok("同 tab 内改搜索词 → seed=undefined（保留旧列表）", r.seed === undefined, `seed=${JSON.stringify(r.seed)}`);
	ok("  · 且 switched=false，cache 未命中", r.switched === false && r.cached === undefined);
}
/* ④ 同 tab 内改分类：同上 */
{
	const r = listSeed(CACHE, "team", "team", "team||创作");
	ok("同 tab 内改分类 → seed=undefined（保留旧列表）", r.seed === undefined);
}
/* ⑤ 大小写/空值边界：首次打开面板（prevKind=null）算「切换」 */
{
	const r = listSeed(new Map(), null, "team", "team||");
	ok("首次打开（prevKind=null）→ 算切换，seed=null", r.seed === null);
}
/* ⑥ 两个 tab 连续来回切，序列必须始终是 null/缓存，绝不出现 undefined 于切换时 */
{
	const cache = new Map(CACHE);
	let prev = null; const trace = [];
	for (const k of ["team", "expert", "team", "expert", "team"]) {
		const r = listSeed(cache, prev, k, `${k}||`);
		trace.push(`${k}:${r.seed === undefined ? "keep" : r.seed === null ? "clear" : "cache"}`);
		prev = k;
	}
	// CACHE 里有 team|| → 首次回 team 就是 cache 命中；expert 无缓存，切换时一律 clear。
	ok("来回切 tab 的 seed 轨迹正确", trace.join(" ") === "team:cache expert:clear team:cache expert:clear team:cache", trace.join(" "));
	// 关键性质：切换时永远不可能是 undefined（那意味着留着上一个 tab 的列表）
	ok("切换时绝不出现 keep（seed!==undefined）", !trace.some((t) => t.endsWith("keep")));
}

/* ⑦ tab 集合：专家团 / 专家 / 市场（0.3.0 新增市场 tab，顺序即面板左右顺序） */
const tabOrder = (src.match(/const TAB_ORDER = \[([^\]]*)\];/)?.[1] ?? "")
	.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
ok('TAB_ORDER = ["team", "expert", "market"]', JSON.stringify(tabOrder) === '["team","expert","market"]', JSON.stringify(tabOrder));
const TABS = { team: "tabTeam", expert: "tabExpert", market: "tabMarket" };
/* ① TAB_LABEL 里每个 tab 都映射到一个文案 key；② 每个 key 在中英两套 STRINGS 里都出现（≥2 次） */
const badLabel = Object.entries(TABS).filter(([k, key]) => {
	const inLabel = new RegExp(`\\b${k}:\\s*"${key}"`).test(src);
	const defined = (src.match(new RegExp(`\\b${key}:`, "g")) ?? []).length;
	return !inLabel || defined < 2;
});
ok("每个 tab 都有文案 key 且 zh/en 两套都给了", badLabel.length === 0, badLabel.map(([k]) => k).join(",") || "3/3");
ok(
	"tab 栏 3 列（市场 tab 有位置）",
	/\.wbsum-tabs\{[^}]*grid-template-columns:repeat\(3,/.test(src),
	String(src.match(/\.wbsum-tabs\{[^}]*\}/)?.[0]?.slice(0, 90)),
);

/* ⑦b 市场 tab 的切换/搜索策略与目录 tab 同构（缓存键多带一份分类维度） */
{
	const mCache = new Map([["team||", { items: [1], total: 1 }]]);
	const mKey = (q = "", cat = "") => `market|${q}|${cat}`;
	let r = listSeed(mCache, "team", "market", mKey());
	ok("team → market（无缓存）→ seed=null 骨架态", r.seed === null && r.switched === true, `seed=${JSON.stringify(r.seed)}`);
	mCache.set(mKey("网文"), { items: [7], total: 1 });
	r = listSeed(mCache, "market", "market", mKey("网文"));
	ok("market 内改搜索词 → seed=undefined（列表不闪）", r.seed === undefined && r.switched === false);
	r = listSeed(mCache, "market", "team", "team||");
	ok("market → team（有缓存）→ seed=缓存", r.seed === mCache.get("team||"), `seed=${r.seed?.items}`);
	const back = listSeed(mCache, "team", "market", mKey());
	ok("切回 market → seed=null（不拿目录 tab 的列表顶替）", back.seed === null && back.cached === undefined);
}

/* ⑧ 组件里确实走的是 listSeed，且「同 tab 改查询」分支不被误写成 setData(null) */
const eff = src.slice(src.indexOf("const { cached, seed } = listSeed("), src.indexOf("}, [kind, debounced, category]);"));
ok("组件调用 listSeed 并按 seed 分支", eff.includes("if (seed !== undefined) setData(seed)"));
ok("组件不再无条件 setData(null)", !/setData\(null\)/.test(eff));

console.log(fails === 0 ? "\n== 全部通过：切 tab 清换数据、同 tab 搜索不闪 ==" : `\n== ${fails} 项失败 ==`);
process.exit(fails === 0 ? 0 : 1);
