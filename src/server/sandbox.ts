import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { repoRoot, taskWorkspaceDir } from "./paths.js";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  mode: "docker" | "host";
}

export class Sandbox {
  constructor(
    private readonly taskId: string,
    private readonly mode = process.env.SANDBOX_MODE ?? "auto",
    private readonly image = process.env.SANDBOX_IMAGE ?? "python:3.13-slim"
  ) {}

  async runPython(args: string[]): Promise<CommandResult> {
    if (this.mode === "host") return this.runHostPython(args);
    if (this.mode === "docker") return this.runDockerPython(args);
    try {
      return await this.runDockerPython(args);
    } catch (error) {
      return this.runHostPython(args, error);
    }
  }

  private async runDockerPython(args: string[]): Promise<CommandResult> {
    const workspace = taskWorkspaceDir(this.taskId);
    await fs.mkdir(workspace, { recursive: true });
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "1000";
    const gid = typeof process.getgid === "function" ? String(process.getgid()) : "1000";
    const dockerArgs = [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      `${uid}:${gid}`,
      "--cpus",
      "2",
      "--memory",
      "1g",
      "--pids-limit",
      "256",
      "-v",
      `${repoRoot}:/skill:ro`,
      "-v",
      `${workspace}:/workspace:rw`,
      "-w",
      "/skill",
      this.image,
      "python",
      ...args.map((arg) => this.toContainerPath(arg))
    ];
    const { stdout, stderr } = await execFileAsync("docker", dockerArgs, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    return { command: `docker ${dockerArgs.join(" ")}`, stdout, stderr, mode: "docker" };
  }

  private async runHostPython(args: string[], dockerError?: unknown): Promise<CommandResult> {
    const { stdout, stderr } = await execFileAsync("python3", args, { cwd: repoRoot, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    const note = dockerError ? `\n[host fallback after docker failure: ${(dockerError as Error).message}]` : "";
    return { command: `python3 ${args.join(" ")}`, stdout, stderr: `${stderr}${note}`, mode: "host" };
  }

  private toContainerPath(arg: string): string {
    const workspace = taskWorkspaceDir(this.taskId);
    if (path.isAbsolute(arg) && arg.startsWith(workspace)) {
      return arg.replace(workspace, "/workspace");
    }
    if (path.isAbsolute(arg) && arg.startsWith(repoRoot)) {
      return arg.replace(repoRoot, "/skill");
    }
    if (arg.startsWith(os.tmpdir())) return arg;
    return arg;
  }
}
