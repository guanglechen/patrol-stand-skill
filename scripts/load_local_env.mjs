import fs from "node:fs";
import path from "node:path";

export function loadLocalEnv(repoRoot = process.cwd()) {
  const files = [
    ".env.local",
    ".env",
    path.join("data", "secrets", "openrouter.env")
  ];
  for (const file of files) {
    const fullPath = path.resolve(repoRoot, file);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex <= 0) return undefined;
  const key = trimmed.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
  return [key, unquote(trimmed.slice(equalsIndex + 1).trim())];
}

function unquote(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
