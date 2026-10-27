/**
 * 垫片安装的安全边界验证（全程在临时 HOME 里跑，绝不碰真实 PATH）。
 *   node tests/shim-check.mjs
 * 断言：首次安装 → 幂等不动盘 → 更新覆盖自己装的 → **他人文件一律跳过** →
 *       无可写目录时安全失败 → 依赖检测给出可执行安装指引。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const realPath = process.env.PATH;
const realHome = process.env.HOME;
const tmpDirs = [];
let fails = 0;
const ok = (label, cond, extra = "") => { if (!cond) fails += 1; console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`); };
const skip = (label, why) => console.log(`  - SKIP ${label} — ${why}`);

function freshEnv() {
	const home = mkdtempSync(join(tmpdir(), "wbshim-"));
	tmpDirs.push(home);
	const bin = join(home, ".local/bin");
	mkdirSync(bin, { recursive: true });
	process.env.HOME = home;
	process.env.PATH = [join(home, ".workbuddy/bin"), bin].join(delimiter);
	return { home, bin };
}
async function loadFresh() {
	// 每次重新导入：模块内 BIN_DIR 由 import.meta.url 定死，但落点靠 env，所以换 env 即换行为
	const mod = await import(`../lib/shims.js?v=${Math.random()}`);
	return mod;
}
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

console.log("① 首次安装");
{
	const { bin } = freshEnv();
	const { installShims } = await loadFresh();
	const r = installShims({});
	ok("落点选中 ~/.local/bin", r.dir === bin, String(r.dir));
	ok("装上 westock-data", existsSync(join(bin, "westock-data")));
	ok("装上 westock-tool", existsSync(join(bin, "westock-tool")));
	if (process.platform === "win32") skip("权限可执行位", "Windows 由扩展名/ACL 决定，stat.mode 无 POSIX 执行位");
	else ok("权限可执行", (statSync(join(bin, "westock-data")).mode & 0o111) !== 0);
	ok("内容与源一致", readFileSync(join(bin, "westock-data"), "utf8") === readFileSync(join(ROOT, "bin/westock-data"), "utf8"));

	console.log("\n② 幂等（第二次不应动盘）");
	const t1 = mtime(join(bin, "westock-data"));
	const { installShims: again } = await loadFresh();
	const r2 = again({});
	ok("unchanged 命中", r2.unchanged.includes("westock-data"), JSON.stringify(r2.unchanged));
	ok("mtime 未变", mtime(join(bin, "westock-data")) === t1);

	console.log("\n③ 源更新 → 覆盖自己装的");
	writeFileSync(join(bin, "westock-data"), "#!/usr/bin/env bash\n# shim-of: dsh-workbuddy-summon\n# 旧版本\n");
	const { installShims: third } = await loadFresh();
	const r3 = third({});
	ok("updated 命中", r3.updated.includes("westock-data"), JSON.stringify(r3.updated));
	ok("已刷新为最新内容", readFileSync(join(bin, "westock-data"), "utf8").includes("WorkBuddy 专家包的命令兼容垫片"));

	console.log("\n④ 他人文件必须跳过（最关键的一条）");
	writeFileSync(join(bin, "westock-tool"), "#!/bin/sh\necho '别人家的 westock-tool'\n");
	const foreign = readFileSync(join(bin, "westock-tool"), "utf8");
	const { installShims: fourth } = await loadFresh();
	const r4 = fourth({});
	ok("skipped 命中 westock-tool", r4.skipped.includes("westock-tool"), JSON.stringify(r4.skipped));
	ok("他人内容未被覆盖", readFileSync(join(bin, "westock-tool"), "utf8") === foreign);

	console.log("\n⑤ 无可写落点 → 安全失败不抛异常");
	// 不能拿「不存在的 HOME」当不可写 —— writableDir 的 mkdirSync(recursive) 会把它建出来。
	// 也不能依赖 chmod（Windows 上不生效）。用一个「同名普通文件当 HOME」：
	// 目录创建必失败，PATH 里也只有这个文件 → 没有任何可写落点。
	const roHome = mkdtempSync(join(tmpdir(), "wbshim-ro-"));
	tmpDirs.push(roHome);
	const blocker = join(roHome, "home-is-a-file");
	writeFileSync(blocker, "not a directory");
	process.env.HOME = blocker;
	process.env.PATH = blocker;
	const { installShims: fifth } = await loadFresh();
	let threw = false;
	let rr;
	try { rr = fifth({}); } catch { threw = true; }
	ok("未抛异常", !threw);
	ok("返回 dir=undefined（无可写落点）", !threw && rr?.dir === undefined, JSON.stringify(rr?.dir));
	ok("failed 里列出未安装的垫片", !threw && (rr?.failed?.length ?? 0) > 0, JSON.stringify(rr?.failed));

	console.log("\n⑥ 依赖检测");
	process.env.HOME = realHome;
	process.env.PATH = realPath;
	const { checkShimDeps } = await loadFresh();
	const deps = checkShimDeps();
	for (const d of deps) ok(`${d.name} 检测结果有指引`, typeof d.hint === "string" && d.hint.length > 10, `ok=${d.ok}`);
	const westock = deps.find((d) => d.name === "westock");
	// 机器上没装 westock 是正常状态（插件不代装，只给安装指引）；断言检测逻辑可复现即可。
	ok(
		"westock 检测结果可复现（未装则 ok=false + 安装指引）",
		typeof westock?.ok === "boolean" && (westock.ok === true || /setup\.sh/.test(westock.hint)),
		`本机 ok=${westock?.ok}`,
	);
}

// 收尾：清理临时 HOME（Windows 无 chmod 需求）
for (const d of tmpDirs) {
	rmSync(d, { recursive: true, force: true });
}
console.log(fails === 0 ? "\nSHIM 全部通过" : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
