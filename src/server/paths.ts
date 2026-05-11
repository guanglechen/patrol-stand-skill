import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

function findRepoRoot(start: string): string {
  let current = start;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json")) && fs.existsSync(path.join(current, "SKILL.md"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(start, "../..");
}

export const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
export const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(repoRoot, "data"));
export const publicDir = path.join(repoRoot, "dist/web");

export function taskDir(taskId: string): string {
  return path.join(dataDir, "tasks", taskId);
}

export function taskInputsDir(taskId: string): string {
  return path.join(taskDir(taskId), "inputs");
}

export function taskWorkspaceDir(taskId: string): string {
  return path.join(taskDir(taskId), "workspace");
}

export function taskOutputsDir(taskId: string): string {
  return path.join(taskDir(taskId), "outputs");
}

export function taskEventsPath(taskId: string): string {
  return path.join(taskDir(taskId), "events.jsonl");
}
