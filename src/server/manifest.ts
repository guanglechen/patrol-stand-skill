import fs from "node:fs/promises";
import path from "node:path";
import { taskWorkspaceDir } from "./paths.js";
import type { TaskManifest } from "./types.js";

export async function writeManifest(manifest: TaskManifest): Promise<string> {
  const portableManifest = await copyInputsToWorkspace(manifest);
  const manifestPath = path.join(taskWorkspaceDir(manifest.task.id), "task-manifest.json");
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(portableManifest, null, 2), "utf8");
  return manifestPath;
}

async function copyInputsToWorkspace(manifest: TaskManifest): Promise<TaskManifest> {
  const inputDir = path.join(taskWorkspaceDir(manifest.task.id), "inputs");
  await fs.mkdir(inputDir, { recursive: true });
  const files = [];
  for (const file of manifest.files) {
    const targetPath = path.join(inputDir, file.storedName);
    await fs.copyFile(file.path, targetPath);
    files.push({
      ...file,
      path: targetPath
    });
  }
  return {
    ...manifest,
    files
  };
}
