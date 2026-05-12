import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "patrol-runner-"));
process.env.DATA_DIR = tempDir;
process.env.SANDBOX_MODE = "host";
delete process.env.LLM_PROVIDER;

const { AppDatabase } = await import("../src/server/db.js");
const { LocalPatrolRunner } = await import("../src/server/local-runner.js");
const { eventBus } = await import("../src/server/events.js");

const db = new AppDatabase();
const runner = new LocalPatrolRunner(db);
const now = new Date().toISOString();
const taskId = randomUUID();

db.createTask({
  id: taskId,
  title: "runner test",
  status: "draft",
  createdAt: now,
  updatedAt: now,
  waitingAskId: null
});
db.addMessage({
  id: randomUUID(),
  taskId,
  role: "user",
  content: "产业园设施设备巡检标准材料",
  createdAt: now,
  askId: null
});

await runner.run(taskId);
assert.equal(db.getTask(taskId)?.status, "waiting_user");
assert.ok((await eventBus.history(taskId)).some((event) => event.type === "agent_ask"));

db.addMessage({
  id: randomUUID(),
  taskId,
  role: "user",
  content: "candidate_boundary",
  askId: "boundary-confirmation",
  createdAt: new Date().toISOString()
});

await runner.run(taskId);
assert.equal(db.getTask(taskId)?.status, "waiting_user");
assert.ok((await eventBus.history(taskId)).some((event) => event.ask?.id === "execution-plan-approval"));
assert.ok(db.listArtifacts(taskId).some((artifact) => artifact.label === "Agent 执行计划"));

db.addMessage({
  id: randomUUID(),
  taskId,
  role: "user",
  content: "approve_execute",
  askId: "execution-plan-approval",
  createdAt: new Date().toISOString()
});

await runner.run(taskId);
const artifacts = db.listArtifacts(taskId);
assert.equal(db.getTask(taskId)?.status, "completed");
assert.ok(artifacts.some((artifact) => artifact.kind === "workbook"));
assert.ok(artifacts.some((artifact) => artifact.kind === "validation"));
assert.equal(artifacts.filter((artifact) => artifact.label === "材料解析摘要").length, 1);
assert.ok((await eventBus.history(taskId)).some((event) => event.tool === "llm_analysis" && event.type === "tool_failed"));

const uploadTaskId = randomUUID();
db.createTask({
  id: uploadTaskId,
  title: "upload branch test",
  status: "draft",
  createdAt: now,
  updatedAt: now,
  waitingAskId: null
});
db.addMessage({
  id: randomUUID(),
  taskId: uploadTaskId,
  role: "user",
  content: "先分析巡检标准",
  createdAt: now,
  askId: null
});
await runner.run(uploadTaskId);
db.addMessage({
  id: randomUUID(),
  taskId: uploadTaskId,
  role: "user",
  content: "need_more_upload",
  askId: "boundary-confirmation",
  createdAt: new Date().toISOString()
});
await runner.run(uploadTaskId);
assert.equal(db.getTask(uploadTaskId)?.status, "waiting_user");

process.env.LLM_PROVIDER = "mock";
const mockTaskId = randomUUID();
db.createTask({
  id: mockTaskId,
  title: "mock llm branch test",
  status: "draft",
  createdAt: now,
  updatedAt: now,
  waitingAskId: null
});
db.addMessage({
  id: randomUUID(),
  taskId: mockTaskId,
  role: "user",
  content: "消防部门负责灭火器、消防泵、通道占用巡检，标准要求异常闭环和留痕。",
  createdAt: now,
  askId: null
});
await runner.run(mockTaskId);
db.addMessage({
  id: randomUUID(),
  taskId: mockTaskId,
  role: "user",
  content: "candidate_boundary",
  askId: "boundary-confirmation",
  createdAt: new Date().toISOString()
});
await runner.run(mockTaskId);
assert.equal(db.getTask(mockTaskId)?.status, "waiting_user");
assert.ok((await eventBus.history(mockTaskId)).some((event) => event.ask?.id === "execution-plan-approval"));
db.addMessage({
  id: randomUUID(),
  taskId: mockTaskId,
  role: "user",
  content: "approve_execute",
  askId: "execution-plan-approval",
  createdAt: new Date().toISOString()
});
await runner.run(mockTaskId);
assert.equal(db.getTask(mockTaskId)?.status, "completed");
assert.ok(db.listArtifacts(mockTaskId).some((artifact) => artifact.label === "LLM 工作簿结构 JSON"));
assert.ok((await eventBus.history(mockTaskId)).some((event) => event.tool === "llm_analysis" && event.type === "tool_completed"));

await fs.rm(tempDir, { recursive: true, force: true });
