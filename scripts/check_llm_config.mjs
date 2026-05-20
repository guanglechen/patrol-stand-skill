import { spawnSync } from "node:child_process";
import { loadLocalEnv } from "./load_local_env.mjs";

loadLocalEnv();

const allowedProviders = new Set(["", "mock", "kimi", "openai", "openrouter"]);
const providerAliases = new Map([
  ["kimi-coding", "kimi"],
  ["open-router", "openrouter"]
]);

const rawProvider = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
const provider = providerAliases.get(rawProvider) ?? rawProvider;
const required = process.env.LLM_REQUIRED === "true";
const warnings = [];
const errors = [];

function envValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isPlaceholder(value) {
  if (!value) return false;
  return /^(replace|change-me|changeme|your-|your_|example|dummy|test)/i.test(value) ||
    /(replace|changeme|example|dummy|placeholder)/i.test(value);
}

function secretState(name) {
  const value = envValue(name);
  if (!value) return { configured: false, redacted: "unset" };
  if (isPlaceholder(value)) {
    return { configured: false, redacted: "placeholder" };
  }
  return { configured: true, redacted: `set:redacted:length=${value.length}` };
}

function publicValue(name, fallback = "") {
  return envValue(name) || fallback;
}

function gitIgnored(path) {
  const result = spawnSync("git", ["check-ignore", "-q", "--", path], {
    stdio: "ignore"
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

function requireSecret(providerName, secretName) {
  const state = secretState(secretName);
  if (!state.configured) {
    errors.push(`${providerName} requires ${secretName}.`);
  }
}

if (!allowedProviders.has(provider)) {
  errors.push(`Unsupported LLM_PROVIDER="${rawProvider}". Use mock, kimi, openai, or openrouter.`);
}

if (process.env.LLM_REQUIRED && process.env.LLM_REQUIRED !== "true" && process.env.LLM_REQUIRED !== "false") {
  warnings.push("LLM_REQUIRED should be true or false.");
}

const secrets = {
  OPENAI_API_KEY: secretState("OPENAI_API_KEY"),
  KIMI_API_KEY: secretState("KIMI_API_KEY"),
  OPENROUTER_API_KEY: secretState("OPENROUTER_API_KEY"),
  PATROL_BRIDGE_TOKEN: secretState("PATROL_BRIDGE_TOKEN")
};

const configuredProviders = {
  mock: provider === "mock",
  kimi: secrets.KIMI_API_KEY.configured,
  openai: secrets.OPENAI_API_KEY.configured,
  openrouter: secrets.OPENROUTER_API_KEY.configured
};

if (provider === "kimi") requireSecret("kimi", "KIMI_API_KEY");
if (provider === "openai") requireSecret("openai", "OPENAI_API_KEY");
if (provider === "openrouter") requireSecret("openrouter", "OPENROUTER_API_KEY");

const selectedProvider = (() => {
  if (provider === "mock") return "mock";
  if (provider === "kimi" || provider === "openai" || provider === "openrouter") return provider;
  if (configuredProviders.kimi && !configuredProviders.openai && !configuredProviders.openrouter) return "kimi";
  if (configuredProviders.openai && !configuredProviders.kimi && !configuredProviders.openrouter) return "openai";
  if (configuredProviders.openrouter && !configuredProviders.kimi && !configuredProviders.openai) return "openrouter";
  if (configuredProviders.kimi || configuredProviders.openai || configuredProviders.openrouter) return "ambiguous";
  return "none";
})();

if (selectedProvider === "ambiguous") {
  warnings.push("Multiple real LLM API keys are configured; set LLM_PROVIDER explicitly.");
}

if (configuredProviders.openrouter && provider !== "openrouter") {
  warnings.push("OPENROUTER_API_KEY is set but LLM_PROVIDER is not openrouter.");
}

if (provider === "openrouter") {
  const baseUrl = publicValue("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") {
      warnings.push("OPENROUTER_BASE_URL should use https for OpenRouter.");
    }
  } catch {
    errors.push("OPENROUTER_BASE_URL must be a valid URL.");
  }
}

const llmConfigured = selectedProvider !== "none" && selectedProvider !== "ambiguous" &&
  (selectedProvider === "mock" || configuredProviders[selectedProvider]);

if (required && !llmConfigured) {
  errors.push("LLM_REQUIRED=true but no usable LLM provider is configured.");
}

const ignoredPaths = {
  ".env": gitIgnored(".env"),
  ".env.local": gitIgnored(".env.local"),
  "data/": gitIgnored("data/"),
  "data/secrets/": gitIgnored("data/secrets/")
};

for (const [path, ignored] of Object.entries(ignoredPaths)) {
  if (ignored === false) errors.push(`${path} is not ignored by git.`);
  if (ignored === null) warnings.push(`Could not verify git ignore status for ${path}.`);
}

const output = {
  ok: errors.length === 0,
  llmConfigured,
  provider: selectedProvider,
  required,
  secrets,
  models: {
    OPENAI_MODEL: publicValue("OPENAI_MODEL", "gpt-5.2"),
    KIMI_MODEL: publicValue("KIMI_MODEL", "kimi-for-coding"),
    OPENROUTER_MODEL: publicValue("OPENROUTER_MODEL", "deepseek/deepseek-v4-pro")
  },
  openrouter: {
    baseUrl: publicValue("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    siteUrl: publicValue("OPENROUTER_SITE_URL"),
    appName: publicValue("OPENROUTER_APP_NAME")
  },
  ignoredPaths,
  warnings,
  errors,
  note: llmConfigured
    ? "LLM provider config is present; secrets are redacted in this report."
    : "Local runner can fall back to deterministic skeleton unless LLM_REQUIRED=true."
};

console.log(JSON.stringify(output, null, 2));

if (errors.length > 0) {
  process.exitCode = 1;
}
