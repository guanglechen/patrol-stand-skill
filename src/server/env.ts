import fs from "node:fs";
import path from "node:path";

const localEnvFiles = [
  ".env.local",
  ".env",
  path.join("data", "secrets", "openrouter.env")
];

for (const relativePath of localEnvFiles) {
  const envPath = path.resolve(process.cwd(), relativePath);
  if (!fs.existsSync(envPath)) continue;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex <= 0) return undefined;
  const key = trimmed.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
  return [key, unquote(trimmed.slice(equalsIndex + 1).trim())];
}

function unquote(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
