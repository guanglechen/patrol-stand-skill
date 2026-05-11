import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "patrol-store-"));
process.env.DATA_DIR = tempDir;

const { AppDatabase } = await import("../src/server/db.js");
const { eventBus } = await import("../src/server/events.js");

const db = new AppDatabase();
const now = new Date().toISOString();
const taskId = randomUUID();
db.createTask({
  id: taskId,
  title: "store test",
  status: "draft",
  createdAt: now,
  updatedAt: now,
  waitingAskId: null
});

db.addMessage({
  id: randomUUID(),
  taskId,
  role: "user",
  content: "测试材料",
  createdAt: now,
  askId: null
});

await eventBus.emitTaskEvent({ taskId, type: "task_created", message: "created", level: "success" });
const history = await eventBus.history(taskId);

assert.equal(db.getTask(taskId)?.title, "store test");
assert.equal(db.listMessages(taskId).length, 1);
assert.equal(history.length, 1);
assert.equal(history[0].type, "task_created");

await fs.rm(tempDir, { recursive: true, force: true });
