import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "./db.js";
import { eventBus } from "./events.js";
import { writeManifest } from "./manifest.js";
import { repoRoot, taskInputsDir, taskOutputsDir, taskWorkspaceDir } from "./paths.js";
import type { TaskArtifact, TaskManifest } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 600_000;

interface PiResourceConfig {
  extensions: string[];
  skills: string[];
  prompts: string[];
}

interface PiModelConfig {
  provider?: string;
  model?: string;
  thinking?: string;
}

const providerAliases: Record<string, string | undefined> = {
  mock: undefined,
  kimi: "kimi-coding",
  "kimi-for-coding": "kimi-coding",
  "kimi-coding": "kimi-coding",
  gemini: "google",
  google: "google",
  openai: "openai",
  openrouter: "openrouter",
  deepseek: "deepseek",
  anthropic: "anthropic"
};

const providerModelEnv: Record<string, string[]> = {
  openrouter: ["OPENROUTER_MODEL"],
  deepseek: ["DEEPSEEK_MODEL"],
  "kimi-coding": ["KIMI_MODEL"],
  openai: ["OPENAI_MODEL"],
  anthropic: ["ANTHROPIC_MODEL"],
  google: ["GEMINI_MODEL", "GOOGLE_MODEL"]
};

const defaultProviderModels: Record<string, string | undefined> = {
  openrouter: "deepseek/deepseek-v4-pro"
};

const providerApiEnv: Array<[provider: string, envNames: string[]]> = [
  ["openrouter", ["OPENROUTER_API_KEY"]],
  ["deepseek", ["DEEPSEEK_API_KEY"]],
  ["kimi-coding", ["KIMI_API_KEY"]],
  ["openai", ["OPENAI_API_KEY"]],
  ["anthropic", ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]],
  ["google", ["GEMINI_API_KEY"]]
];

export class PiAgentRunner {
  private readonly running = new Set<string>();

  constructor(private readonly db: AppDatabase) {}

  async run(taskId: string): Promise<void> {
    if (this.running.has(taskId)) return;
    this.running.add(taskId);
    try {
      await this.execute(taskId);
    } finally {
      this.running.delete(taskId);
    }
  }

  private async execute(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.db.updateTaskStatus(taskId, "running");
    await eventBus.emitTaskEvent({ taskId, type: "run_started", message: "Pi runner started.", level: "info" });

    const manifest = this.buildManifest(taskId);
    await writeManifest(manifest);
    const resources = await this.loadResourceConfig();
    const modelConfig = this.resolveModelConfig();

    const workspace = taskWorkspaceDir(taskId);
    const outputs = taskOutputsDir(taskId);
    await fs.mkdir(outputs, { recursive: true });
    const transcriptPath = path.join(outputs, "pi-transcript.txt");
    const prompt = this.buildPrompt();
    const args = this.buildPiArgs(resources, modelConfig, prompt);
    const env = this.buildPiEnv(taskId, workspace);

    await eventBus.emitTaskEvent({
      taskId,
      type: "tool_completed",
      tool: "pi_runtime_config",
      message: "Pi runtime configured.",
      level: "info",
      data: {
        extensions: resources.extensions.length,
        skills: resources.skills.length,
        prompts: resources.prompts.length,
        provider: modelConfig.provider ?? "default",
        model: modelConfig.model ?? "default"
      }
    });

    try {
      const { stdout, stderr } = await execFileAsync("npx", ["pi", ...args], {
        cwd: repoRoot,
        env,
        timeout: Number(process.env.PI_RUNNER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
        maxBuffer: 20 * 1024 * 1024
      });
      await fs.writeFile(transcriptPath, `${stdout}\n${stderr}`, "utf8");
      await this.registerArtifact(taskId, "Pi 运行转录", "trace", transcriptPath);
      const refreshed = this.db.getTask(taskId);
      if (refreshed?.status === "waiting_user") return;
      this.db.updateTaskStatus(taskId, "completed");
      await eventBus.emitTaskEvent({ taskId, type: "task_completed", message: "Pi runner completed.", level: "success" });
    } catch (error) {
      this.db.updateTaskStatus(taskId, "failed");
      const message = (error as Error).message;
      await fs.writeFile(transcriptPath, message, "utf8");
      await this.registerArtifact(taskId, "Pi 运行错误", "trace", transcriptPath);
      await eventBus.emitTaskEvent({ taskId, type: "task_failed", message, level: "error" });
      throw error;
    }
  }

  private async loadResourceConfig(): Promise<PiResourceConfig> {
    const packageJsonPath = path.join(repoRoot, "package.json");
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      pi?: {
        extensions?: unknown;
        skills?: unknown;
        prompts?: unknown;
      };
    };
    const piConfig = packageJson.pi ?? {};

    return {
      extensions: this.mergeResourceList(
        this.envResourceList("PI_AGENT_EXTENSIONS", "PI_EXTENSIONS") ?? this.asStringList(piConfig.extensions, "package.json pi.extensions"),
        this.envResourceList("PI_AGENT_EXTRA_EXTENSIONS", "PI_EXTRA_EXTENSIONS")
      ),
      skills: this.mergeResourceList(
        this.envResourceList("PI_AGENT_SKILLS", "PI_SKILLS") ?? this.asStringList(piConfig.skills, "package.json pi.skills"),
        this.envResourceList("PI_AGENT_EXTRA_SKILLS", "PI_EXTRA_SKILLS")
      ),
      prompts: this.mergeResourceList(
        this.envResourceList("PI_AGENT_PROMPTS", "PI_PROMPTS") ?? this.asStringList(piConfig.prompts, "package.json pi.prompts"),
        this.envResourceList("PI_AGENT_EXTRA_PROMPTS", "PI_EXTRA_PROMPTS")
      )
    };
  }

  private buildPiArgs(resources: PiResourceConfig, modelConfig: PiModelConfig, prompt: string): string[] {
    const args = ["--no-session"];
    if (process.env.PI_AGENT_ALLOW_BUILTIN_TOOLS !== "true") {
      args.push("--no-builtin-tools");
    }

    if (modelConfig.provider) {
      args.push("--provider", modelConfig.provider);
    }
    if (modelConfig.model) {
      args.push("--model", modelConfig.model);
    }
    if (modelConfig.thinking) {
      args.push("--thinking", modelConfig.thinking);
    }

    for (const extension of this.resolveResourcePaths(resources.extensions)) {
      args.push("--extension", extension);
    }
    for (const skill of this.resolveResourcePaths(resources.skills)) {
      args.push("--skill", skill);
    }
    for (const promptPath of this.resolveResourcePaths(resources.prompts)) {
      args.push("--append-system-prompt", promptPath);
    }

    args.push("--print", prompt);
    return args;
  }

  private buildPiEnv(taskId: string, workspace: string): NodeJS.ProcessEnv {
    const bridgeUrl =
      process.env.PI_AGENT_BRIDGE_URL ??
      process.env.PATROL_AGENT_BRIDGE_URL ??
      `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? "8787"}`;
    const bridgeToken = process.env.PI_AGENT_BRIDGE_TOKEN ?? process.env.PATROL_BRIDGE_TOKEN ?? "";
    const inputs = taskInputsDir(taskId);
    const outputs = taskOutputsDir(taskId);

    return {
      ...process.env,
      PI_AGENT_TASK_ID: taskId,
      PI_AGENT_TASK_WORKSPACE: workspace,
      PI_AGENT_TASK_INPUTS: inputs,
      PI_AGENT_TASK_OUTPUTS: outputs,
      PI_AGENT_BRIDGE_URL: bridgeUrl,
      PI_AGENT_BRIDGE_TOKEN: bridgeToken,
      PATROL_TASK_ID: taskId,
      PATROL_TASK_WORKSPACE: workspace,
      PATROL_TASK_INPUTS: inputs,
      PATROL_TASK_OUTPUTS: outputs,
      PATROL_AGENT_BRIDGE_URL: bridgeUrl,
      PATROL_BRIDGE_TOKEN: bridgeToken
    };
  }

  private resolveModelConfig(): PiModelConfig {
    const rawModel = firstEnv("PI_AGENT_MODEL", "PI_MODEL");
    const explicitProvider = normalizeProvider(firstEnv("PI_AGENT_PROVIDER", "PI_PROVIDER"));
    const llmProvider = normalizeProvider(firstEnv("LLM_PROVIDER"));
    const provider =
      explicitProvider ??
      llmProvider ??
      this.inferProviderFromModelEnv() ??
      this.inferProviderFromApiEnv() ??
      inferProviderFromModelPrefix(rawModel);
    const providerModel = provider ? firstEnv(...(providerModelEnv[provider] ?? [])) : undefined;
    const model = normalizeModelForProvider(rawModel ?? providerModel ?? defaultProviderModels[provider ?? ""], provider);
    const thinking = firstEnv("PI_AGENT_THINKING", "PI_THINKING");
    return { provider, model, thinking };
  }

  private inferProviderFromModelEnv(): string | undefined {
    for (const [provider, envNames] of Object.entries(providerModelEnv)) {
      if (firstEnv(...envNames)) return provider;
    }
    return undefined;
  }

  private inferProviderFromApiEnv(): string | undefined {
    for (const [provider, envNames] of providerApiEnv) {
      if (firstEnv(...envNames)) return provider;
    }
    return undefined;
  }

  private resolveResourcePaths(resources: string[]): string[] {
    return resources.map((resource) => resolveResourcePath(resource));
  }

  private mergeResourceList(base: string[], extra?: string[]): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const resource of [...base, ...(extra ?? [])]) {
      if (seen.has(resource)) continue;
      seen.add(resource);
      merged.push(resource);
    }
    return merged;
  }

  private envResourceList(...names: string[]): string[] | undefined {
    for (const name of names) {
      const value = process.env[name];
      if (value === undefined) continue;
      return parseEnvList(name, value);
    }
    return undefined;
  }

  private asStringList(value: unknown, source: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      throw new Error(`${source} must be an array of strings.`);
    }
    return value.map((entry) => entry.trim()).filter(Boolean);
  }

  private buildManifest(taskId: string): TaskManifest {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return {
      task,
      files: this.db.listFiles(taskId),
      messages: this.db.listMessages(taskId),
      answers: this.db.listAnswers(taskId)
    };
  }

  private buildPrompt(): string {
    return [
      "Read the task manifest with read_task_manifest.",
      "Use the configured skills, prompts, and extensions to complete the task.",
      "Use list_task_files/read_task_file for uploaded materials and list_skill_files/read_skill_file for skill references.",
      "Use run_terminal_command for terminal work; do not assume direct shell access is available.",
      "Emit stage and tool progress with emit_event when that tool is available.",
      "If required information is missing or a decision would be unsafe to assume, call ask_user_web and stop after emitting the ask.",
      "Write intermediate files only inside the task workspace.",
      "Register useful final outputs, validation reports, and traces with save_artifact when that tool is available."
    ].join("\n");
  }

  private async registerArtifact(taskId: string, label: string, kind: TaskArtifact["kind"], artifactPath: string): Promise<void> {
    const stat = await fs.stat(artifactPath);
    const existing = this.db
      .listArtifacts(taskId)
      .find((artifact) => artifact.label === label && artifact.path === artifactPath);
    if (existing) return;
    const artifact: TaskArtifact = {
      id: randomUUID(),
      taskId,
      label,
      kind,
      path: artifactPath,
      size: stat.size,
      createdAt: new Date().toISOString()
    };
    this.db.addArtifact(artifact);
    await eventBus.emitTaskEvent({
      taskId,
      type: "artifact_ready",
      message: `${label} ready`,
      level: "success",
      artifact
    });
  }
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseEnvList(name: string, value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      throw new Error(`${name} must be a JSON array of strings.`);
    }
    return parsed.map((entry) => entry.trim()).filter(Boolean);
  }

  return trimmed
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeProvider(provider: string | undefined): string | undefined {
  if (!provider) return undefined;
  const normalized = provider.toLowerCase();
  return Object.prototype.hasOwnProperty.call(providerAliases, normalized) ? providerAliases[normalized] : normalized;
}

function inferProviderFromModelPrefix(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) return undefined;
  return normalizeProvider(model.slice(0, slashIndex));
}

function normalizeModelForProvider(model: string | undefined, provider: string | undefined): string | undefined {
  if (!model || !provider) return model;
  const normalizedProvider = normalizeProvider(provider);
  const providerPrefixes = new Set([provider, normalizedProvider].filter((entry): entry is string => Boolean(entry)));
  if (normalizedProvider === "kimi-coding") {
    providerPrefixes.add("kimi");
    providerPrefixes.add("kimi-for-coding");
  }
  for (const prefix of providerPrefixes) {
    const modelPrefix = `${prefix}/`;
    if (model.startsWith(modelPrefix)) {
      return model.slice(modelPrefix.length);
    }
  }
  return model;
}

function resolveResourcePath(resource: string): string {
  const expanded =
    resource === "~" ? os.homedir() : resource.startsWith("~/") ? path.join(os.homedir(), resource.slice(2)) : resource;
  return path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
}
