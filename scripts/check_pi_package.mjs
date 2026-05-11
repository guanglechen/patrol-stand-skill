import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));

const required = [
  ...(packageJson.pi?.extensions ?? []),
  ...(packageJson.pi?.skills ?? []),
  ...(packageJson.pi?.prompts ?? []),
];

if (!required.length) {
  throw new Error("package.json does not declare any pi resources.");
}

for (const resource of required) {
  const resolved = path.resolve(repoRoot, resource);
  try {
    await fs.access(resolved);
  } catch {
    throw new Error(`Pi resource is missing: ${resource}`);
  }
}

const { stdout, stderr } = await execFileAsync("npx", ["pi", "--version"], {
  cwd: repoRoot,
  timeout: 30_000,
});
const piVersion = (stdout || stderr).trim();
if (!piVersion) {
  throw new Error("Pi CLI responded without a version string.");
}

console.log(JSON.stringify({
  ok: true,
  piVersion,
  resources: required,
}, null, 2));
