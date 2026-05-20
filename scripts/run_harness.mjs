#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./load_local_env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(repoRoot);
const localTsx = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const command = existsSync(localTsx) ? localTsx : process.platform === "win32" ? "npx.cmd" : "npx";
const args = existsSync(localTsx)
  ? ["harness/src/cli.ts", ...process.argv.slice(2)]
  : ["tsx", "harness/src/cli.ts", ...process.argv.slice(2)];

const child = spawn(command, args, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Harness stopped by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
