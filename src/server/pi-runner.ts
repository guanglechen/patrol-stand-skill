import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "./db.js";
import { eventBus } from "./events.js";
import { writeManifest } from "./manifest.js";
import { repoRoot, taskOutputsDir, taskWorkspaceDir } from "./paths.js";
import type { TaskArtifact, TaskManifest } from "./types.js";

const execFileAsync = promisify(execFile);

export class PiPatrolRunner {
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

    const workspace = taskWorkspaceDir(taskId);
    const outputs = taskOutputsDir(taskId);
    await fs.mkdir(outputs, { recursive: true });
    const transcriptPath = path.join(outputs, "pi-transcript.txt");
    const prompt = this.buildPrompt();

    const args = [
      "--no-session",
      "--extension",
      path.join(repoRoot, "pi/extensions/patrol-session-bridge.ts"),
      "--skill",
      path.join(repoRoot, "SKILL.md"),
      "--skill",
      path.join(repoRoot, "pi/skills/excel-workbook-quality"),
      "--append-system-prompt",
      path.join(repoRoot, "pi/prompts/patrol-agent.md"),
      "--print",
      prompt
    ];

    const env = {
      ...process.env,
      PATROL_TASK_ID: taskId,
      PATROL_TASK_WORKSPACE: workspace,
      PATROL_AGENT_BRIDGE_URL: process.env.PATROL_AGENT_BRIDGE_URL ?? `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? "8787"}`,
      PATROL_BRIDGE_TOKEN: process.env.PATROL_BRIDGE_TOKEN ?? ""
    };

    try {
      const { stdout, stderr } = await execFileAsync("npx", ["pi", ...args], {
        cwd: workspace,
        env,
        timeout: Number(process.env.PI_RUNNER_TIMEOUT_MS ?? 600_000),
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
      "Analyze the uploaded text and attachments as a patrol standard task.",
      "Emit stage and tool progress with emit_event.",
      "If responsibility boundaries or object hierarchy choices are unclear, call ask_user_web and stop after emitting the ask.",
      "When enough information exists, build the structured workbook case JSON in the task workspace, render the workbook using scripts/render_workbook.py from the skill package, validate it with scripts/validate_workbook.py, and register artifacts with save_artifact.",
      "Keep the workbook contract from references/workbook-contract.md."
    ].join("\n");
  }

  private async registerArtifact(taskId: string, label: string, kind: TaskArtifact["kind"], artifactPath: string): Promise<void> {
    const stat = await fs.stat(artifactPath);
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
