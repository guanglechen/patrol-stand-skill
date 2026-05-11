import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.PATROL_AGENT_BRIDGE_URL ?? "http://127.0.0.1:8787";
const taskId = process.env.PATROL_TASK_ID;
const bridgeToken = process.env.PATROL_BRIDGE_TOKEN;

export default function patrolSessionBridge(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_task_manifest",
    description: "Read the current patrol standard analysis task manifest from the task workspace.",
    parameters: Type.Object({}),
    async execute() {
      const manifestPath = requireTaskPath("task-manifest.json");
      return await fs.readFile(manifestPath, "utf8");
    }
  });

  pi.registerTool({
    name: "emit_event",
    description: "Emit a stage-level or tool-level progress event to the local patrol WebChat.",
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
    async execute(input) {
      await postBridge(`/api/internal/tasks/${requireTaskId()}/events`, input);
      return "event emitted";
    }
  });

  pi.registerTool({
    name: "ask_user_web",
    description: "Pause the patrol analysis and ask the WebChat user for a structured decision.",
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
    async execute(input) {
      await postBridge(`/api/internal/tasks/${requireTaskId()}/ask`, input);
      return "ask emitted; wait for user answer before continuing";
    }
  });

  pi.registerTool({
    name: "save_artifact",
    description: "Register an output artifact produced in the task workspace.",
    parameters: Type.Object({
      label: Type.String(),
      kind: Type.Union([Type.Literal("workbook"), Type.Literal("trace"), Type.Literal("validation"), Type.Literal("manifest"), Type.Literal("other")]),
      relativePath: Type.String()
    }),
    async execute(input) {
      const workspacePath = requireTaskPath(input.relativePath);
      await postBridge(`/api/internal/tasks/${requireTaskId()}/artifacts`, {
        ...input,
        path: workspacePath
      });
      return `artifact registered: ${input.label}`;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Patrol session bridge loaded. Web ask and artifact tools are available.", "info");
  });
}

function requireTaskId(): string {
  if (!taskId) throw new Error("PATROL_TASK_ID is required for patrol-session-bridge.");
  return taskId;
}

function requireTaskPath(relativePath: string): string {
  const workspace = process.env.PATROL_TASK_WORKSPACE ?? process.cwd();
  const resolved = path.resolve(workspace, relativePath);
  if (!resolved.startsWith(path.resolve(workspace))) {
    throw new Error("Refusing to access a path outside the task workspace.");
  }
  return resolved;
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
