import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { installOpenRouterFetchBridge } from "./openrouter-fetch-bridge.js";
import type { AppDatabase as AppDatabaseClass } from "../../src/server/db.js";
import type { LocalPatrolRunner as LocalPatrolRunnerClass } from "../../src/server/local-runner.js";
import type { TaskArtifact, TaskEvent, TaskFile, TaskMessage, TaskRecord, TaskStatus } from "../../src/server/types.js";

type HarnessProvider = "mock" | "openrouter";

interface ScenarioAttachment {
  name: string;
  mimeType: string;
  content: string;
}

interface ScenarioStep {
  type: "run" | "answer";
  askId?: string;
  content?: string;
  expectAskId?: string;
}

interface ScenarioExpected {
  status: TaskStatus;
  requiredAskIds?: string[];
  requiredArtifactLabels?: string[];
  requiredTools?: string[];
  forbiddenEventTypes?: string[];
  forbiddenArtifactKinds?: TaskArtifact["kind"][];
}

interface Scenario {
  id: string;
  title: string;
  message: string;
  attachments?: ScenarioAttachment[];
  steps: ScenarioStep[];
  expected: ScenarioExpected;
}

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

interface ScenarioResult {
  id: string;
  title: string;
  taskId: string;
  status: TaskStatus | "missing";
  passed: boolean;
  score: number;
  maxScore: number;
  durationMs: number;
  checks: CheckResult[];
  errors: string[];
  events: TaskEvent[];
  artifacts: TaskArtifact[];
  task?: TaskRecord;
  files: TaskFile[];
  messages: TaskMessage[];
}

interface CliOptions {
  provider: HarnessProvider;
  fixturesPath: string;
  scenarios: string[];
  runId: string;
  list: boolean;
  help: boolean;
}

interface RuntimeImports {
  AppDatabase: typeof AppDatabaseClass;
  LocalPatrolRunner: typeof LocalPatrolRunnerClass;
  eventBus: typeof import("../../src/server/events.js").eventBus;
  taskInputsDir: typeof import("../../src/server/paths.js").taskInputsDir;
  taskWorkspaceDir: typeof import("../../src/server/paths.js").taskWorkspaceDir;
  taskOutputsDir: typeof import("../../src/server/paths.js").taskOutputsDir;
}

const repoRoot = path.resolve(process.cwd());
let timestampOffset = 0;
process.on("uncaughtException", reportFatal);
process.on("unhandledRejection", (reason) => reportFatal(reason instanceof Error ? reason : new Error(String(reason))));
const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const scenarios = await loadScenarios(options.fixturesPath);
const selectedScenarios = options.scenarios.length
  ? scenarios.filter((scenario) => options.scenarios.includes(scenario.id))
  : scenarios;

if (options.list) {
  for (const scenario of scenarios) {
    console.log(`${scenario.id}\t${scenario.title}`);
  }
  process.exit(0);
}

if (!selectedScenarios.length) {
  throw new Error(`No scenarios matched: ${options.scenarios.join(", ") || "(none)"}`);
}

const runDir = path.join(repoRoot, "harness", "runs", options.runId);
const dataDir = path.join(runDir, "data");
await fs.mkdir(runDir, { recursive: true });
configureProvider(options.provider, runDir);
process.env.DATA_DIR = dataDir;
process.env.SANDBOX_MODE = process.env.SANDBOX_MODE || "host";
process.env.PATROL_RUNNER = "local";

const runtime = await loadRuntime();
const db = new runtime.AppDatabase();
const runner = new runtime.LocalPatrolRunner(db);
const startedAt = new Date().toISOString();
const results: ScenarioResult[] = [];

console.log(`Harness run ${options.runId}`);
console.log(`Provider: ${options.provider}`);
console.log(`Run dir: ${runDir}`);

for (const scenario of selectedScenarios) {
  const result = await runScenario(scenario, db, runner, runtime);
  results.push(result);
  console.log(`${result.passed ? "PASS" : "FAIL"} ${scenario.id} ${result.score}/${result.maxScore}`);
}

const completedAt = new Date().toISOString();
await writeRunOutputs({
  runId: options.runId,
  provider: options.provider,
  runDir,
  dataDir,
  startedAt,
  completedAt,
  results
});

const passed = results.every((result) => result.passed);
console.log(`Summary: ${results.filter((result) => result.passed).length}/${results.length} scenario(s) passed`);
console.log(`Artifacts: ${path.join(runDir, "trace.json")}`);
process.exit(passed ? 0 : 1);

async function loadRuntime(): Promise<RuntimeImports> {
  const [{ AppDatabase }, { LocalPatrolRunner }, { eventBus }, paths] = await Promise.all([
    import("../../src/server/db.js"),
    import("../../src/server/local-runner.js"),
    import("../../src/server/events.js"),
    import("../../src/server/paths.js")
  ]);
  return {
    AppDatabase,
    LocalPatrolRunner,
    eventBus,
    taskInputsDir: paths.taskInputsDir,
    taskWorkspaceDir: paths.taskWorkspaceDir,
    taskOutputsDir: paths.taskOutputsDir
  };
}

function parseArgs(args: string[]): CliOptions {
  const parsed: CliOptions = {
    provider: normalizeProvider(process.env.HARNESS_PROVIDER ?? "mock"),
    fixturesPath: path.join(repoRoot, "harness", "fixtures", "scenarios.json"),
    scenarios: [],
    runId: process.env.HARNESS_RUN_ID || createRunId(),
    list: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--list") {
      parsed.list = true;
      continue;
    }
    if (arg === "--provider") {
      parsed.provider = normalizeProvider(requiredValue(args, ++index, "--provider"));
      continue;
    }
    if (arg.startsWith("--provider=")) {
      parsed.provider = normalizeProvider(arg.slice("--provider=".length));
      continue;
    }
    if (arg === "--fixtures") {
      parsed.fixturesPath = path.resolve(requiredValue(args, ++index, "--fixtures"));
      continue;
    }
    if (arg.startsWith("--fixtures=")) {
      parsed.fixturesPath = path.resolve(arg.slice("--fixtures=".length));
      continue;
    }
    if (arg === "--scenario") {
      parsed.scenarios.push(requiredValue(args, ++index, "--scenario"));
      continue;
    }
    if (arg.startsWith("--scenario=")) {
      parsed.scenarios.push(arg.slice("--scenario=".length));
      continue;
    }
    if (arg === "--run-id") {
      parsed.runId = requiredValue(args, ++index, "--run-id");
      continue;
    }
    if (arg.startsWith("--run-id=")) {
      parsed.runId = arg.slice("--run-id=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function normalizeProvider(value: string): HarnessProvider {
  if (value === "mock" || value === "openrouter") return value;
  throw new Error(`Unsupported harness provider: ${value}. Expected mock or openrouter.`);
}

function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

async function loadScenarios(fixturesPath: string): Promise<Scenario[]> {
  const raw = await fs.readFile(fixturesPath, "utf8");
  const loaded = JSON.parse(raw) as Scenario[];
  for (const scenario of loaded) {
    if (!scenario.id || !scenario.title || !scenario.message || !Array.isArray(scenario.steps)) {
      throw new Error(`Invalid scenario fixture: ${JSON.stringify(scenario)}`);
    }
  }
  return loaded;
}

function configureProvider(provider: HarnessProvider, runDir: string): void {
  if (provider === "mock") {
    process.env.LLM_PROVIDER = "mock";
    delete process.env.OPENAI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.LLM_REQUIRED;
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for --provider openrouter.");
  }
  const model = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4-pro";
  process.env.OPENAI_API_KEY = apiKey;
  process.env.OPENAI_MODEL = model;
  process.env.LLM_REQUIRED = process.env.LLM_REQUIRED ?? "true";
  delete process.env.LLM_PROVIDER;
  delete process.env.KIMI_API_KEY;
  installOpenRouterFetchBridge({
    runDir,
    apiKey,
    model,
    appTitle: process.env.OPENROUTER_APP_TITLE,
    siteUrl: process.env.OPENROUTER_SITE_URL
  });
}

async function runScenario(
  scenario: Scenario,
  db: AppDatabaseClass,
  runner: LocalPatrolRunnerClass,
  runtime: RuntimeImports
): Promise<ScenarioResult> {
  const started = Date.now();
  const errors: string[] = [];
  const taskId = randomUUID();
  await ensureTaskDirs(taskId, runtime);
  createTask(db, taskId, scenario.title);
  await emitTaskCreated(taskId, scenario.title, runtime);
  await addUserMessage(db, runtime, taskId, scenario.message);
  for (const attachment of scenario.attachments ?? []) {
    await addAttachment(db, runtime, taskId, attachment);
  }

  for (const step of scenario.steps) {
    try {
      if (step.type === "answer") {
        if (!step.askId || !step.content) throw new Error(`Answer step in ${scenario.id} is missing askId/content.`);
        await addUserMessage(db, runtime, taskId, step.content, step.askId);
        continue;
      }

      await runner.run(taskId);
      if (step.expectAskId) {
        const task = db.getTask(taskId);
        if (task?.waitingAskId !== step.expectAskId) {
          errors.push(`Expected waiting ask ${step.expectAskId}, got ${task?.waitingAskId ?? "(none)"}.`);
        }
      }
    } catch (error) {
      errors.push((error as Error).message);
      break;
    }
  }

  const task = db.getTask(taskId);
  const events = await runtime.eventBus.history(taskId);
  const artifacts = db.listArtifacts(taskId);
  const files = db.listFiles(taskId);
  const messages = db.listMessages(taskId);
  const checks = scoreScenario(scenario, task, events, artifacts, errors);
  const score = checks.filter((check) => check.passed).length;
  return {
    id: scenario.id,
    title: scenario.title,
    taskId,
    status: task?.status ?? "missing",
    passed: score === checks.length,
    score,
    maxScore: checks.length,
    durationMs: Date.now() - started,
    checks,
    errors,
    events,
    artifacts,
    task,
    files,
    messages
  };
}

async function ensureTaskDirs(taskId: string, runtime: RuntimeImports): Promise<void> {
  await Promise.all([
    fs.mkdir(runtime.taskInputsDir(taskId), { recursive: true }),
    fs.mkdir(runtime.taskWorkspaceDir(taskId), { recursive: true }),
    fs.mkdir(runtime.taskOutputsDir(taskId), { recursive: true })
  ]);
}

function createTask(db: AppDatabaseClass, taskId: string, title: string): void {
  const now = timestamp();
  db.createTask({
    id: taskId,
    title,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    waitingAskId: null
  });
}

async function emitTaskCreated(taskId: string, title: string, runtime: RuntimeImports): Promise<void> {
  await runtime.eventBus.emitTaskEvent({ taskId, type: "task_created", message: title, level: "success" });
}

async function addUserMessage(
  db: AppDatabaseClass,
  runtime: RuntimeImports,
  taskId: string,
  content: string,
  askId: string | null = null
): Promise<void> {
  const message: TaskMessage = {
    id: randomUUID(),
    taskId,
    role: "user",
    content,
    askId,
    createdAt: timestamp()
  };
  db.addMessage(message);
  if (askId) {
    db.updateTaskStatus(taskId, "draft", null);
    await runtime.eventBus.emitTaskEvent({
      taskId,
      type: "user_answered",
      message: content,
      level: "success",
      data: { askId }
    });
  } else {
    await runtime.eventBus.emitTaskEvent({ taskId, type: "message_added", message: content, level: "success" });
  }
}

async function addAttachment(
  db: AppDatabaseClass,
  runtime: RuntimeImports,
  taskId: string,
  attachment: ScenarioAttachment
): Promise<void> {
  const id = randomUUID();
  const originalName = sanitizeName(attachment.name);
  const storedName = `${id}-${originalName}`;
  const filePath = path.join(runtime.taskInputsDir(taskId), storedName);
  await fs.writeFile(filePath, attachment.content, "utf8");
  const stat = await fs.stat(filePath);
  const record: TaskFile = {
    id,
    taskId,
    originalName,
    storedName,
    mimeType: attachment.mimeType,
    size: stat.size,
    path: filePath,
    createdAt: timestamp()
  };
  db.addFile(record);
  await runtime.eventBus.emitTaskEvent({
    taskId,
    type: "file_uploaded",
    message: originalName,
    level: "success",
    data: { size: stat.size, mimeType: attachment.mimeType }
  });
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment.txt";
}

function timestamp(): string {
  timestampOffset += 1000;
  return new Date(Date.now() + timestampOffset).toISOString();
}

function scoreScenario(
  scenario: Scenario,
  task: TaskRecord | undefined,
  events: TaskEvent[],
  artifacts: TaskArtifact[],
  errors: string[]
): CheckResult[] {
  const expected = scenario.expected;
  const checks: CheckResult[] = [
    {
      name: "scenario executed without harness errors",
      passed: errors.length === 0,
      detail: errors.join("; ")
    },
    {
      name: `final status is ${expected.status}`,
      passed: task?.status === expected.status,
      detail: `actual=${task?.status ?? "missing"}`
    }
  ];

  for (const askId of expected.requiredAskIds ?? []) {
    checks.push({
      name: `ask emitted: ${askId}`,
      passed: events.some((event) => event.ask?.id === askId),
      detail: matchingEvents(events, (event) => event.ask?.id === askId)
    });
  }

  for (const label of expected.requiredArtifactLabels ?? []) {
    checks.push({
      name: `artifact ready: ${label}`,
      passed: artifacts.some((artifact) => artifact.label === label),
      detail: artifacts.map((artifact) => artifact.label).join(", ")
    });
  }

  for (const tool of expected.requiredTools ?? []) {
    checks.push({
      name: `tool observed: ${tool}`,
      passed: events.some((event) => event.tool === tool),
      detail: matchingEvents(events, (event) => event.tool === tool)
    });
  }

  for (const eventType of expected.forbiddenEventTypes ?? []) {
    checks.push({
      name: `event forbidden: ${eventType}`,
      passed: !events.some((event) => event.type === eventType),
      detail: matchingEvents(events, (event) => event.type === eventType)
    });
  }

  for (const artifactKind of expected.forbiddenArtifactKinds ?? []) {
    checks.push({
      name: `artifact kind forbidden: ${artifactKind}`,
      passed: !artifacts.some((artifact) => artifact.kind === artifactKind),
      detail: artifacts.map((artifact) => `${artifact.kind}:${artifact.label}`).join(", ")
    });
  }

  return checks;
}

function matchingEvents(events: TaskEvent[], predicate: (event: TaskEvent) => boolean): string {
  return events
    .filter(predicate)
    .map((event) => `${event.type}:${event.message}`)
    .slice(0, 5)
    .join(" | ");
}

async function writeRunOutputs(payload: {
  runId: string;
  provider: HarnessProvider;
  runDir: string;
  dataDir: string;
  startedAt: string;
  completedAt: string;
  results: ScenarioResult[];
}): Promise<void> {
  const totals = {
    scenarios: payload.results.length,
    passed: payload.results.filter((result) => result.passed).length,
    failed: payload.results.filter((result) => !result.passed).length,
    score: payload.results.reduce((sum, result) => sum + result.score, 0),
    maxScore: payload.results.reduce((sum, result) => sum + result.maxScore, 0)
  };
  const trace = {
    runId: payload.runId,
    provider: payload.provider,
    startedAt: payload.startedAt,
    completedAt: payload.completedAt,
    runDir: payload.runDir,
    dataDir: payload.dataDir,
    totals,
    scenarios: payload.results
  };
  const scorecard = {
    runId: payload.runId,
    provider: payload.provider,
    totals,
    scenarios: payload.results.map((result) => ({
      id: result.id,
      title: result.title,
      taskId: result.taskId,
      status: result.status,
      passed: result.passed,
      score: result.score,
      maxScore: result.maxScore,
      durationMs: result.durationMs,
      checks: result.checks
    }))
  };
  const eventsJsonl = payload.results
    .flatMap((result) => result.events.map((event) => JSON.stringify({ scenarioId: result.id, ...event })))
    .join("\n");

  await Promise.all([
    writeJson(path.join(payload.runDir, "trace.json"), trace),
    writeJson(path.join(payload.runDir, "scorecard.json"), scorecard),
    fs.writeFile(path.join(payload.runDir, "events.jsonl"), eventsJsonl ? `${eventsJsonl}\n` : "", "utf8"),
    fs.writeFile(path.join(payload.runDir, "summary.md"), buildSummary(payload, totals), "utf8")
  ]);
}

function buildSummary(
  payload: {
    runId: string;
    provider: HarnessProvider;
    runDir: string;
    dataDir: string;
    startedAt: string;
    completedAt: string;
    results: ScenarioResult[];
  },
  totals: { scenarios: number; passed: number; failed: number; score: number; maxScore: number }
): string {
  const lines = [
    `# Harness Run ${payload.runId}`,
    "",
    `- Provider: ${payload.provider}`,
    `- Started: ${payload.startedAt}`,
    `- Completed: ${payload.completedAt}`,
    `- Result: ${totals.passed}/${totals.scenarios} scenarios passed`,
    `- Score: ${totals.score}/${totals.maxScore}`,
    `- Data dir: ${payload.dataDir}`,
    "",
    "## Scenarios",
    ""
  ];

  for (const result of payload.results) {
    lines.push(
      `### ${result.passed ? "PASS" : "FAIL"} ${result.id}`,
      "",
      `- Status: ${result.status}`,
      `- Score: ${result.score}/${result.maxScore}`,
      `- Task: ${result.taskId}`,
      `- Events: ${result.events.length}`,
      `- Artifacts: ${result.artifacts.map((artifact) => `${artifact.kind}:${artifact.label}`).join("; ") || "none"}`,
      ""
    );
    for (const check of result.checks) {
      lines.push(`- [${check.passed ? "x" : " "}] ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    }
    if (result.errors.length) {
      lines.push("", `Errors: ${result.errors.join("; ")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function printHelp(): void {
  console.log(`Usage: node scripts/run_harness.mjs [options]

Options:
  --provider mock|openrouter   Provider mode. Defaults to mock.
  --scenario <id>              Run one scenario. May be repeated.
  --fixtures <path>            Scenario JSON path.
  --run-id <id>                Override run id.
  --list                       List scenario ids.
  --help                       Show this help.

OpenRouter mode requires OPENROUTER_API_KEY and defaults OPENROUTER_MODEL to deepseek/deepseek-v4-pro.
`);
}

function reportFatal(error: Error): void {
  console.error(`Harness failed: ${error.message}`);
  process.exit(1);
}
