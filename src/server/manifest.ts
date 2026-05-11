import fs from "node:fs/promises";
import path from "node:path";
import { taskWorkspaceDir } from "./paths.js";
import type { TaskManifest } from "./types.js";

export async function writeManifest(manifest: TaskManifest): Promise<string> {
  const manifestPath = path.join(taskWorkspaceDir(manifest.task.id), "task-manifest.json");
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}
