import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const baseUrl = process.env.PATROL_AGENT_BRIDGE_URL ?? "http://127.0.0.1:8787";
const taskId = process.env.PATROL_TASK_ID;
const bridgeToken = process.env.PATROL_BRIDGE_TOKEN;
const execFileAsync = promisify(execFile);
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultReadLimitBytes = 1024 * 1024;
const maxReadLimitBytes = 5 * 1024 * 1024;
const defaultListLimit = 500;
const maxListLimit = 2_000;
const defaultCommandTimeoutMs = 120_000;
const maxCommandTimeoutMs = 120_000;
const maxCommandOutputBytes = 512 * 1024;
const deniedCommands = new Set([
  "bash",
  "brew",
  "chgrp",
  "chmod",
  "chown",
  "curl",
  "dd",
  "diskutil",
  "docker",
  "doas",
  "fish",
  "ftp",
  "gh",
  "git",
  "kill",
  "killall",
  "kubectl",
  "launchctl",
  "mkfs",
  "mount",
  "nc",
  "ncat",
  "netcat",
  "npm",
  "npx",
  "open",
  "osascript",
  "pip",
  "pip3",
  "pkill",
  "pnpm",
  "podman",
  "powershell",
  "pwsh",
  "rm",
  "rmdir",
  "rsync",
  "scp",
  "security",
  "sftp",
  "sh",
  "ssh",
  "su",
  "sudo",
  "telnet",
  "umount",
  "wget",
  "xargs",
  "yarn",
  "zsh"
]);
const deniedInlineFlags = new Set(["-c", "--command", "-e", "--eval"]);
const deniedPythonModules = new Set(["ensurepip", "pip", "pip3", "venv", "virtualenv"]);

interface ListFilesInput {
  root?: "input" | "workspace" | "output";
  relativeDir?: string;
  recursive?: boolean;
  maxEntries?: number;
}

interface ReadFileInput {
  root?: "input" | "workspace" | "output";
  relativePath: string;
  maxBytes?: number;
}

interface RunTerminalCommandInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

interface FileEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
}

export default function patrolSessionBridge(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_task_manifest",
    label: "Read Task Manifest",
    description: "Read the current patrol standard analysis task manifest from the task workspace.",
    promptSnippet: "read_task_manifest() reads task metadata, uploaded file records, user messages, and prior answers.",
    parameters: Type.Object({}),
    async execute() {
      const manifestPath = requireTaskPath("task-manifest.json");
      return textResult(await fs.readFile(manifestPath, "utf8"));
    }
  });

  pi.registerTool({
    name: "list_task_files",
    label: "List Task Files",
    description: "List uploaded inputs, workspace files, or outputs for the current task.",
    promptSnippet: "list_task_files({ root }) lists uploaded inputs, workspace files, or outputs. root is input, workspace, or output.",
    parameters: Type.Object({
      root: Type.Optional(Type.Union([Type.Literal("input"), Type.Literal("workspace"), Type.Literal("output")])),
      relativeDir: Type.Optional(Type.String()),
      recursive: Type.Optional(Type.Boolean()),
      maxEntries: Type.Optional(Type.Integer())
    }),
    async execute(_toolCallId, input: ListFilesInput) {
      const rootName = input.root ?? "input";
      const root = taskRoot(rootName);
      const startPath = resolveInsideRoot(root, input.relativeDir ?? "", `task ${rootName}`);
      await assertExistingPathInsideRoot(startPath, root, `task ${rootName}`);
      const files = await listScopedFiles(startPath, root, input);
      return textResult(JSON.stringify({ root: rootName, files }, null, 2), { count: files.length, root: rootName });
    }
  });

  pi.registerTool({
    name: "read_task_file",
    label: "Read Task File",
    description: "Read a UTF-8 text file from uploaded inputs, workspace files, or outputs.",
    promptSnippet: "read_task_file({ root, relativePath }) reads uploaded materials or generated workspace files.",
    parameters: Type.Object({
      root: Type.Optional(Type.Union([Type.Literal("input"), Type.Literal("workspace"), Type.Literal("output")])),
      relativePath: Type.String(),
      maxBytes: Type.Optional(Type.Integer())
    }),
    async execute(_toolCallId, input: ReadFileInput) {
      const rootName = input.root ?? "input";
      const root = taskRoot(rootName);
      const filePath = resolveInsideRoot(root, input.relativePath, `task ${rootName}`);
      await assertExistingPathInsideRoot(filePath, root, `task ${rootName}`);
      return textResult(await readTextFile(filePath, input.maxBytes));
    }
  });

  pi.registerTool({
    name: "list_skill_files",
    label: "List Skill Files",
    description: "List files from the loaded patrol skill package: SKILL.md, scripts, references, and pi resources.",
    promptSnippet: "list_skill_files() lists allowed skill resources such as SKILL.md, references, scripts, and pi resources.",
    parameters: Type.Object({
      relativeDir: Type.Optional(Type.String()),
      recursive: Type.Optional(Type.Boolean()),
      maxEntries: Type.Optional(Type.Integer())
    }),
    async execute(_toolCallId, input: ListFilesInput) {
      const files = await listSkillFiles(input);
      return textResult(JSON.stringify({ root: "skill", files }, null, 2), { count: files.length });
    }
  });

  pi.registerTool({
    name: "read_skill_file",
    label: "Read Skill File",
    description: "Read a UTF-8 text file from the loaded patrol skill package. Paths must stay inside allowed skill resources.",
    promptSnippet: "read_skill_file({ relativePath }) reads allowed skill files such as SKILL.md and references/*.md.",
    parameters: Type.Object({
      relativePath: Type.String(),
      maxBytes: Type.Optional(Type.Integer())
    }),
    async execute(_toolCallId, input: ReadFileInput) {
      const filePath = requireSkillPath(input.relativePath);
      await assertExistingPathInsideAnyRoot(filePath, skillAccessRoots(), "skill resources");
      return textResult(await readTextFile(filePath, input.maxBytes));
    }
  });

  pi.registerTool({
    name: "run_terminal_command",
    label: "Run Terminal Command",
    description: "Run a non-shell terminal command in the task workspace. Use task:<path> or skill:<path> aliases for path arguments.",
    promptSnippet: "run_terminal_command({ command, args }) runs a safe non-shell command in the task workspace.",
    parameters: Type.Object({
      command: Type.String(),
      args: Type.Optional(Type.Array(Type.String())),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer())
    }),
    async execute(_toolCallId, input: RunTerminalCommandInput) {
      const result = await runTerminalCommand(input);
      return textResult(JSON.stringify(result, null, 2), result);
    }
  });

  pi.registerTool({
    name: "emit_event",
    label: "Emit Event",
    description: "Emit a stage-level or tool-level progress event to the local patrol WebChat.",
    promptSnippet: "emit_event({ type, message }) reports visible task progress to the WebChat.",
    parameters: Type.Object({
      type: Type.Union([
        Type.Literal("stage_started"),
        Type.Literal("stage_completed"),
        Type.Literal("tool_started"),
        Type.Literal("tool_completed"),
        Type.Literal("tool_failed")
      ]),
      message: Type.String(),
      stage: Type.Optional(Type.String()),
      tool: Type.Optional(Type.String()),
      level: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error"), Type.Literal("success")]))
    }),
    async execute(_toolCallId, input) {
      await postBridge(`/api/internal/tasks/${requireTaskId()}/events`, input);
      return textResult("event emitted");
    }
  });

  pi.registerTool({
    name: "ask_user_web",
    label: "Ask User Web",
    description: "Pause the patrol analysis and ask the WebChat user for a structured decision.",
    promptSnippet: "ask_user_web(...) pauses the task for a structured user decision when information is missing.",
    parameters: Type.Object({
      id: Type.String(),
      title: Type.String(),
      body: Type.String(),
      inputKind: Type.Union([Type.Literal("single_select"), Type.Literal("multi_select"), Type.Literal("text"), Type.Literal("attachment")]),
      required: Type.Boolean(),
      options: Type.Optional(Type.Array(Type.Object({
        label: Type.String(),
        value: Type.String(),
        description: Type.Optional(Type.String()),
        recommended: Type.Optional(Type.Boolean())
      }))),
      defaultValue: Type.Optional(Type.Any())
    }),
    async execute(_toolCallId, input) {
      await postBridge(`/api/internal/tasks/${requireTaskId()}/ask`, input);
      return textResult("ask emitted; wait for user answer before continuing");
    }
  });

  pi.registerTool({
    name: "save_artifact",
    label: "Save Artifact",
    description: "Register an output artifact produced in the task workspace.",
    promptSnippet: "save_artifact({ label, kind, relativePath }) registers final outputs and traces from the task workspace.",
    parameters: Type.Object({
      label: Type.String(),
      kind: Type.Union([Type.Literal("workbook"), Type.Literal("trace"), Type.Literal("validation"), Type.Literal("manifest"), Type.Literal("other")]),
      relativePath: Type.String()
    }),
    async execute(_toolCallId, input) {
      const workspacePath = requireTaskPath(input.relativePath);
      await postBridge(`/api/internal/tasks/${requireTaskId()}/artifacts`, {
        ...input,
        path: workspacePath
      });
      return textResult(`artifact registered: ${input.label}`);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Patrol session bridge loaded. Web ask and artifact tools are available.", "info");
  });
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details
  };
}

function requireTaskId(): string {
  if (!taskId) throw new Error("PATROL_TASK_ID is required for patrol-session-bridge.");
  return taskId;
}

function requireTaskPath(relativePath: string): string {
  return resolveInsideRoot(taskWorkspace(), relativePath, "task workspace");
}

function taskWorkspace(): string {
  return path.resolve(process.env.PATROL_TASK_WORKSPACE ?? process.cwd());
}

function taskInputs(): string {
  return path.resolve(process.env.PATROL_TASK_INPUTS ?? path.join(taskWorkspace(), "..", "inputs"));
}

function taskOutputs(): string {
  return path.resolve(process.env.PATROL_TASK_OUTPUTS ?? path.join(taskWorkspace(), "..", "outputs"));
}

function taskRoot(root: "input" | "workspace" | "output"): string {
  if (root === "workspace") return taskWorkspace();
  if (root === "output") return taskOutputs();
  return taskInputs();
}

function requireSkillPath(relativePath: string): string {
  const resolved = path.resolve(skillRoot, normalizeRelativePath(relativePath, false));
  if (!isInsideAnyRoot(resolved, skillAccessRoots())) {
    throw new Error("Refusing to access a path outside allowed skill resources.");
  }
  return resolved;
}

function skillAccessRoots(): string[] {
  return [
    path.join(skillRoot, "SKILL.md"),
    path.join(skillRoot, "scripts"),
    path.join(skillRoot, "references"),
    path.join(skillRoot, "pi")
  ];
}

function resolveInsideRoot(root: string, relativePath: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalizeRelativePath(relativePath, true));
  if (!isInsideRoot(resolvedRoot, resolved)) {
    throw new Error(`Refusing to access a path outside the ${label}.`);
  }
  return resolved;
}

function normalizeRelativePath(relativePath: string, allowEmpty: boolean): string {
  if (typeof relativePath !== "string") {
    throw new Error("Path must be a string.");
  }
  if (relativePath.includes("\0")) {
    throw new Error("Path must not contain null bytes.");
  }
  if (relativePath.includes("\\")) {
    throw new Error("Use POSIX-style forward slashes in paths.");
  }
  if (relativePath.startsWith("~")) {
    throw new Error("Home-directory expansion is not allowed.");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error("Absolute paths are not allowed here.");
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized === ".") {
    if (allowEmpty) return "";
    throw new Error("Path is required.");
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Parent directory traversal is not allowed.");
  }
  return normalized;
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isInsideAnyRoot(target: string, roots: string[]): boolean {
  return roots.some((root) => isInsideRoot(root, target));
}

async function assertExistingPathInsideRoot(target: string, root: string, label: string): Promise<void> {
  const [realTarget, realRoot] = await Promise.all([fs.realpath(target), fs.realpath(root)]);
  if (!isInsideRoot(realRoot, realTarget)) {
    throw new Error(`Refusing to access a path outside the ${label}.`);
  }
}

async function assertExistingPathInsideAnyRoot(target: string, roots: string[], label: string): Promise<void> {
  const realTarget = await fs.realpath(target);
  for (const root of roots) {
    try {
      const realRoot = await fs.realpath(root);
      if (isInsideRoot(realRoot, realTarget)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Refusing to access a path outside ${label}.`);
}

async function listSkillFiles(input: ListFilesInput): Promise<FileEntry[]> {
  const relativeDir = input.relativeDir ?? "";
  if (relativeDir) {
    const startPath = requireSkillPath(relativeDir);
    await assertExistingPathInsideAnyRoot(startPath, skillAccessRoots(), "skill resources");
    return await listScopedFiles(startPath, skillRoot, input);
  }

  const limit = clampInteger(input.maxEntries, defaultListLimit, 1, maxListLimit);
  const entries: FileEntry[] = [];
  for (const root of skillAccessRoots()) {
    try {
      await fs.lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const remaining = limit - entries.length;
    if (remaining <= 0) break;
    entries.push(...await listScopedFiles(root, skillRoot, { ...input, maxEntries: remaining }));
  }
  return entries.slice(0, limit);
}

async function listScopedFiles(startPath: string, displayRoot: string, input: ListFilesInput): Promise<FileEntry[]> {
  const recursive = input.recursive ?? true;
  const limit = clampInteger(input.maxEntries, defaultListLimit, 1, maxListLimit);
  const entries: FileEntry[] = [];

  async function visit(currentPath: string): Promise<void> {
    if (entries.length >= limit) return;
    const stat = await fs.lstat(currentPath);
    entries.push(toFileEntry(currentPath, displayRoot, stat));
    if (!recursive || !stat.isDirectory() || stat.isSymbolicLink()) return;
    const children = await fs.readdir(currentPath);
    children.sort((left, right) => left.localeCompare(right));
    for (const child of children) {
      if (entries.length >= limit) break;
      if (child === "." || child === "..") continue;
      await visit(path.join(currentPath, child));
    }
  }

  await visit(startPath);
  return entries;
}

function toFileEntry(filePath: string, displayRoot: string, stat: Awaited<ReturnType<typeof fs.lstat>>): FileEntry {
  return {
    path: path.relative(displayRoot, filePath) || ".",
    kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other",
    size: Number(stat.size),
    modifiedAt: stat.mtime.toISOString()
  };
}

async function readTextFile(filePath: string, maxBytes: number | undefined): Promise<string> {
  const limit = clampInteger(maxBytes, defaultReadLimitBytes, 1, maxReadLimitBytes);
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Only regular files can be read.");
    const fileSize = Number(stat.size);
    const bytesToRead = Math.min(fileSize, limit);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    const suffix = fileSize > limit ? `\n\n[truncated: ${fileSize - limit} bytes not shown]` : "";
    return `${buffer.toString("utf8")}${suffix}`;
  } finally {
    await handle.close();
  }
}

async function runTerminalCommand(input: RunTerminalCommandInput): Promise<Record<string, unknown>> {
  const command = normalizeCommand(input.command);
  assertCommandAllowed(command, input.args ?? []);
  const cwd = input.cwd ? requireTaskPath(input.cwd) : taskWorkspace();
  await assertExistingPathInsideRoot(cwd, taskWorkspace(), "task workspace");
  const args = (input.args ?? []).map((arg) => resolveCommandArg(arg, cwd));
  const timeout = clampInteger(input.timeoutMs, defaultCommandTimeoutMs, 1_000, maxCommandTimeoutMs);

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout,
      maxBuffer: maxCommandOutputBytes * 2,
      env: commandEnvironment(),
      windowsHide: true
    });
    return {
      ok: true,
      command,
      args,
      cwd,
      exitCode: 0,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr)
    };
  } catch (error) {
    const commandError = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: string | number;
      signal?: string;
      killed?: boolean;
      message: string;
    };
    return {
      ok: false,
      command,
      args,
      cwd,
      exitCode: commandError.code ?? null,
      signal: commandError.signal ?? null,
      timedOut: commandError.killed === true,
      stdout: truncateOutput(commandError.stdout ?? ""),
      stderr: truncateOutput(commandError.stderr ?? commandError.message)
    };
  }
}

function normalizeCommand(command: string): string {
  if (!command || command.includes("\0")) {
    throw new Error("Command is required.");
  }
  if (command.includes("/") || command.includes("\\") || command.includes(":")) {
    throw new Error("Command must be a PATH command name, not a path.");
  }
  return command;
}

function assertCommandAllowed(command: string, args: string[]): void {
  const normalized = command.toLowerCase();
  if (deniedCommands.has(normalized)) {
    throw new Error(`Command is blocked by the patrol bridge denylist: ${command}`);
  }
  for (const arg of args) {
    if (deniedInlineFlags.has(arg)) {
      throw new Error(`Inline execution flag is blocked: ${arg}`);
    }
  }
  if (normalized === "python" || normalized === "python3") {
    const moduleIndex = args.findIndex((arg) => arg === "-m");
    if (moduleIndex >= 0 && deniedPythonModules.has((args[moduleIndex + 1] ?? "").toLowerCase())) {
      throw new Error(`Python module is blocked by the patrol bridge denylist: ${args[moduleIndex + 1]}`);
    }
  }
}

function resolveCommandArg(arg: string, cwd: string): string {
  if (arg.includes("\0")) {
    throw new Error("Command arguments must not contain null bytes.");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
    throw new Error("URL arguments are not allowed in terminal commands.");
  }
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex > 0 && shouldResolveCommandPath(arg.slice(equalsIndex + 1))) {
    const key = arg.slice(0, equalsIndex + 1);
    return `${key}${resolveCommandPathToken(arg.slice(equalsIndex + 1), cwd)}`;
  }
  if (!shouldResolveCommandPath(arg)) return arg;
  return resolveCommandPathToken(arg, cwd);
}

function shouldResolveCommandPath(value: string): boolean {
  return (
    value.startsWith("task:") ||
    value.startsWith("skill:") ||
    value.startsWith(".") ||
    value.startsWith("~") ||
    path.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function resolveCommandPathToken(value: string, cwd: string): string {
  if (value.startsWith("task:")) {
    return requireTaskPath(value.slice("task:".length));
  }
  if (value.startsWith("skill:")) {
    return requireSkillPath(value.slice("skill:".length));
  }
  if (value.startsWith("~")) {
    throw new Error("Home-directory expansion is not allowed in terminal command paths.");
  }
  if (value.includes("\\")) {
    throw new Error("Use POSIX-style forward slashes in terminal command paths.");
  }
  if (path.isAbsolute(value)) {
    if (!isInsideTaskRoot(value) && !isInsideAnyRoot(value, skillAccessRoots())) {
      throw new Error("Absolute command path arguments must stay inside task inputs, workspace, outputs, or skill resources.");
    }
    return value;
  }
  return resolveInsideRoot(cwd, value, "task workspace");
}

function isInsideTaskRoot(target: string): boolean {
  return [taskInputs(), taskWorkspace(), taskOutputs()].some((root) => isInsideRoot(root, target));
}

function commandEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "",
    PYTHONIOENCODING: "utf-8"
  };
}

function truncateOutput(value: string | Buffer): string {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxCommandOutputBytes) return text;
  return `${buffer.subarray(0, maxCommandOutputBytes).toString("utf8")}\n\n[truncated: ${buffer.length - maxCommandOutputBytes} bytes not shown]`;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(value, max));
}

async function postBridge(route: string, payload: unknown): Promise<void> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bridgeToken ? { "X-Patrol-Bridge-Token": bridgeToken } : {})
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Bridge request failed: ${response.status} ${await response.text()}`);
  }
}
