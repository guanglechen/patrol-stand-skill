import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { dataDir } from "./paths.js";
import type { TaskArtifact, TaskFile, TaskMessage, TaskRecord, TaskStatus } from "./types.js";

const require = createRequire(import.meta.url);

type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

function openDatabase(): DatabaseSync {
  // node:sqlite is available in the project runtime and avoids native npm deps.
  // It is still experimental in Node 22, so keep its use isolated here.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
  return new sqlite.DatabaseSync(path.join(dataDir, "patrol-agent.sqlite"));
}

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor() {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = openDatabase();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        waitingAskId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        originalName TEXT NOT NULL,
        storedName TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        askId TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        createdAt TEXT NOT NULL
      );
    `);
  }

  createTask(task: TaskRecord): void {
    this.db
      .prepare("INSERT INTO tasks (id, title, status, waitingAskId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
      .run(task.id, task.title, task.status, task.waitingAskId ?? null, task.createdAt, task.updatedAt);
  }

  updateTaskStatus(id: string, status: TaskStatus, waitingAskId: string | null = null): void {
    this.db
      .prepare("UPDATE tasks SET status = ?, waitingAskId = ?, updatedAt = ? WHERE id = ?")
      .run(status, waitingAskId, new Date().toISOString(), id);
  }

  getTask(id: string): TaskRecord | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRecord | undefined;
  }

  listTasks(): TaskRecord[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY createdAt DESC").all() as TaskRecord[];
  }

  addFile(file: TaskFile): void {
    this.db
      .prepare("INSERT INTO files (id, taskId, originalName, storedName, mimeType, size, path, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(file.id, file.taskId, file.originalName, file.storedName, file.mimeType, file.size, file.path, file.createdAt);
  }

  listFiles(taskId: string): TaskFile[] {
    return this.db.prepare("SELECT * FROM files WHERE taskId = ? ORDER BY createdAt ASC").all(taskId) as TaskFile[];
  }

  addMessage(message: TaskMessage): void {
    this.db
      .prepare("INSERT INTO messages (id, taskId, role, content, askId, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.id, message.taskId, message.role, message.content, message.askId ?? null, message.createdAt);
  }

  listMessages(taskId: string): TaskMessage[] {
    return this.db.prepare("SELECT * FROM messages WHERE taskId = ? ORDER BY createdAt ASC").all(taskId) as TaskMessage[];
  }

  listAnswers(taskId: string): TaskMessage[] {
    return this.db.prepare("SELECT * FROM messages WHERE taskId = ? AND askId IS NOT NULL ORDER BY createdAt ASC").all(taskId) as TaskMessage[];
  }

  addArtifact(artifact: TaskArtifact): void {
    this.db
      .prepare("INSERT INTO artifacts (id, taskId, label, kind, path, size, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(artifact.id, artifact.taskId, artifact.label, artifact.kind, artifact.path, artifact.size, artifact.createdAt);
  }

  listArtifacts(taskId: string): TaskArtifact[] {
    return this.db.prepare("SELECT * FROM artifacts WHERE taskId = ? ORDER BY createdAt ASC").all(taskId) as TaskArtifact[];
  }

  getArtifact(taskId: string, artifactId: string): TaskArtifact | undefined {
    return this.db.prepare("SELECT * FROM artifacts WHERE taskId = ? AND id = ?").get(taskId, artifactId) as TaskArtifact | undefined;
  }
}
