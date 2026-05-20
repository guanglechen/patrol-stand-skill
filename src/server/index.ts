import "./env.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { AppDatabase } from "./db.js";
import { eventBus } from "./events.js";
import { dataDir, publicDir, repoRoot, taskDir, taskInputsDir, taskOutputsDir, taskWorkspaceDir } from "./paths.js";
import { createRunner } from "./runner.js";
import type { AgentAsk, TaskArtifact, TaskFile, TaskMessage, TaskRecord } from "./types.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const db = new AppDatabase();
const runner = createRunner(db);
const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });

await app.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 20
  }
});

if (fs.existsSync(publicDir)) {
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/"
  });
}

app.get("/api/health", async () => ({
  ok: true,
  dataDir,
  repoRoot,
  sandboxMode: process.env.SANDBOX_MODE ?? "auto",
  runnerMode: process.env.PI_AGENT_RUNNER === "pi" || process.env.PATROL_RUNNER === "pi" ? "pi" : "local",
  piCliAvailable: await commandExists("pi")
}));

app.get("/api/tasks", async () => db.listTasks());

app.post("/api/tasks", async (request, reply) => {
  const body = (request.body ?? {}) as { title?: string; message?: string };
  const now = new Date().toISOString();
  const task: TaskRecord = {
    id: randomUUID(),
    title: body.title?.trim() || "巡检标准分析任务",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    waitingAskId: null
  };
  await ensureTaskDirs(task.id);
  db.createTask(task);
  await eventBus.emitTaskEvent({ taskId: task.id, type: "task_created", message: task.title, level: "success" });
  if (body.message?.trim()) {
    await addUserMessage(task.id, body.message.trim());
  }
  reply.code(201);
  return task;
});

app.get("/api/tasks/:taskId", async (request, reply) => {
  const { taskId } = request.params as { taskId: string };
  const task = db.getTask(taskId);
  if (!task) return reply.code(404).send({ error: "Task not found" });
  return {
    task,
    files: db.listFiles(taskId),
    messages: db.listMessages(taskId),
    artifacts: toArtifactResponses(taskId)
  };
});

app.post("/api/tasks/:taskId/messages", async (request, reply) => {
  const { taskId } = request.params as { taskId: string };
  if (!db.getTask(taskId)) return reply.code(404).send({ error: "Task not found" });
  const body = (request.body ?? {}) as { content?: string; askId?: string };
  if (!body.content?.trim()) return reply.code(400).send({ error: "content is required" });
  const message = await addUserMessage(taskId, body.content.trim(), body.askId);
  if (body.askId) {
    db.updateTaskStatus(taskId, "draft", null);
    await eventBus.emitTaskEvent({
      taskId,
      type: "user_answered",
      message: body.content.trim(),
      level: "success",
      data: { askId: body.askId }
    });
  }
  return message;
});

app.post("/api/tasks/:taskId/files", async (request, reply) => {
  const { taskId } = request.params as { taskId: string };
  if (!db.getTask(taskId)) return reply.code(404).send({ error: "Task not found" });
  const parts = request.parts();
  const saved: TaskFile[] = [];
  for await (const part of parts) {
    if (part.type !== "file") continue;
    const originalName = sanitizeName(part.filename || "attachment.bin");
    const id = randomUUID();
    const storedName = `${id}-${originalName}`;
    const filePath = path.join(taskInputsDir(taskId), storedName);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, await part.toBuffer());
    const stat = await fsp.stat(filePath);
    const record: TaskFile = {
      id,
      taskId,
      originalName,
      storedName,
      mimeType: part.mimetype,
      size: stat.size,
      path: filePath,
      createdAt: new Date().toISOString()
    };
    db.addFile(record);
    saved.push(record);
    await eventBus.emitTaskEvent({
      taskId,
      type: "file_uploaded",
      message: originalName,
      level: "success",
      data: { size: stat.size, mimeType: part.mimetype }
    });
  }
  return saved;
});

app.post("/api/tasks/:taskId/run", async (request, reply) => {
  const { taskId } = request.params as { taskId: string };
  if (!db.getTask(taskId)) return reply.code(404).send({ error: "Task not found" });
  void runner.run(taskId).catch((error) => {
    app.log.error({ err: error, taskId }, "runner failed");
  });
  return { ok: true };
});

app.get("/api/tasks/:taskId/events", async (request, reply) => {
  const { taskId } = request.params as { taskId: string };
  if (!db.getTask(taskId)) return reply.code(404).send({ error: "Task not found" });
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of await eventBus.history(taskId)) send(event);
  const unsubscribe = eventBus.subscribe(taskId, send);
  request.raw.on("close", unsubscribe);
});

app.get("/api/tasks/:taskId/artifacts", async (request, reply) => {
  const { taskId } = request.params as { taskId: string };
  if (!db.getTask(taskId)) return reply.code(404).send({ error: "Task not found" });
  return toArtifactResponses(taskId);
});

app.get("/api/tasks/:taskId/artifacts/:artifactId/download", async (request, reply) => {
  const { taskId, artifactId } = request.params as { taskId: string; artifactId: string };
  const artifact = db.getArtifact(taskId, artifactId);
  if (!artifact) return reply.code(404).send({ error: "Artifact not found" });
  reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(path.basename(artifact.path))}"`);
  return reply.send(fs.createReadStream(artifact.path));
});

app.post("/api/internal/tasks/:taskId/events", async (request, reply) => {
  const { taskId } = request.params as { taskId: string };
  if (!db.getTask(taskId)) return reply.code(404).send({ error: "Task not found" });
  if (!authorizeBridge(request.headers["x-patrol-bridge-token"])) return reply.code(401).send({ error: "Unauthorized bridge request" });
  const body = request.body as {
    type?: TaskEventBodyType;
    message?: string;
    stage?: string;
    tool?: string;
    level?: "info" | "warning" | "error" | "success";
  };
  if (!body.type || !body.message) return reply.code(400).send({ error: "type and message are required" });
  await eventBus.emitTaskEvent({
    taskId,
    type: body.type,
    message: body.message,
    stage: body.stage,
    tool: body.tool,
    level: body.level ?? "info"
  });
  return { ok: true };
});

app.post("/api/internal/tasks/:taskId/ask", async (request, reply) => {
  const { taskId } = request.params as { taskId: string };
  if (!db.getTask(taskId)) return reply.code(404).send({ error: "Task not found" });
  if (!authorizeBridge(request.headers["x-patrol-bridge-token"])) return reply.code(401).send({ error: "Unauthorized bridge request" });
  const ask = request.body as AgentAsk;
  if (!ask.id || !ask.title || !ask.body || !ask.inputKind) return reply.code(400).send({ error: "invalid ask payload" });
  db.updateTaskStatus(taskId, "waiting_user", ask.id);
  await eventBus.emitTaskEvent({
    taskId,
    type: "agent_ask",
    message: ask.title,
    level: "warning",
    ask
  });
  return { ok: true };
});

app.post("/api/internal/tasks/:taskId/artifacts", async (request, reply) => {
  const { taskId } = request.params as { taskId: string };
  if (!db.getTask(taskId)) return reply.code(404).send({ error: "Task not found" });
  if (!authorizeBridge(request.headers["x-patrol-bridge-token"])) return reply.code(401).send({ error: "Unauthorized bridge request" });
  const body = request.body as { label?: string; kind?: TaskArtifact["kind"]; path?: string };
  if (!body.label || !body.kind || !body.path) return reply.code(400).send({ error: "label, kind and path are required" });
  let artifactPath: string;
  try {
    artifactPath = assertTaskScopedPath(taskId, body.path);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
  const stat = await fsp.stat(artifactPath);
  const existing = db
    .listArtifacts(taskId)
    .find((artifact) => artifact.label === body.label && artifact.path === artifactPath);
  if (existing) return existing;
  const artifact: TaskArtifact = {
    id: randomUUID(),
    taskId,
    label: body.label,
    kind: body.kind,
    path: artifactPath,
    size: stat.size,
    createdAt: new Date().toISOString()
  };
  db.addArtifact(artifact);
  await eventBus.emitTaskEvent({
    taskId,
    type: "artifact_ready",
    message: `${artifact.label} ready`,
    level: "success",
    artifact
  });
  return artifact;
});

if (fs.existsSync(publicDir)) {
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

await fsp.mkdir(dataDir, { recursive: true });
await app.listen({ host, port });

async function ensureTaskDirs(taskId: string): Promise<void> {
  await Promise.all([
    fsp.mkdir(taskInputsDir(taskId), { recursive: true }),
    fsp.mkdir(taskWorkspaceDir(taskId), { recursive: true }),
    fsp.mkdir(taskOutputsDir(taskId), { recursive: true })
  ]);
}

async function addUserMessage(taskId: string, content: string, askId?: string): Promise<TaskMessage> {
  const message: TaskMessage = {
    id: randomUUID(),
    taskId,
    role: "user",
    content,
    askId: askId ?? null,
    createdAt: new Date().toISOString()
  };
  db.addMessage(message);
  await eventBus.emitTaskEvent({
    taskId,
    type: "message_added",
    message: content,
    level: "info",
    data: askId ? { askId } : undefined
  });
  return message;
}

function toArtifactResponses(taskId: string): Array<Record<string, unknown>> {
  return db.listArtifacts(taskId).map((artifact) => ({
    ...artifact,
    downloadUrl: `/api/tasks/${taskId}/artifacts/${artifact.id}/download`
  }));
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_").slice(0, 160);
}

function authorizeBridge(rawToken: string | string[] | undefined): boolean {
  const expected = process.env.PATROL_BRIDGE_TOKEN;
  if (!expected) return true;
  const actual = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  return actual === expected;
}

function assertTaskScopedPath(taskId: string, requestedPath: string): string {
  const scopedRoot = path.resolve(taskDir(taskId));
  const resolved = path.resolve(requestedPath);
  if (!resolved.startsWith(`${scopedRoot}${path.sep}`) && resolved !== scopedRoot) {
    throw new Error("Artifact path must stay inside the task directory.");
  }
  return resolved;
}

async function commandExists(command: string): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], (error) => resolve(!error));
  });
}

type TaskEventBodyType =
  | "stage_started"
  | "stage_completed"
  | "tool_started"
  | "tool_completed"
  | "tool_failed";
