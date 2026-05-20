import { AppDatabase } from "./db.js";
import { LocalPatrolRunner } from "./local-runner.js";
import { PiAgentRunner } from "./pi-runner.js";

export interface AgentRunner {
  run(taskId: string): Promise<void>;
}

export function createRunner(db: AppDatabase): AgentRunner {
  const runnerMode = process.env.PI_AGENT_RUNNER ?? process.env.PATROL_RUNNER;
  if (runnerMode === "pi") {
    return new PiAgentRunner(db);
  }
  return new LocalPatrolRunner(db);
}
