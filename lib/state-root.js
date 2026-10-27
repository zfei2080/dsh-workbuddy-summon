/**
 * 状态根目录（独立模块，避免 catalog 与 state 之间出现 ESM 循环依赖）。
 */
import { join } from "node:path";
import { homedir } from "node:os";

export const STATE_ROOT = join(homedir(), ".dsh/workbuddy-summon");
