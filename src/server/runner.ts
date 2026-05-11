import { AppDatabase } from "./db.js";
import { LocalPatrolRunner } from "./local-runner.js";
import { PiPatrolRunner } from "./pi-runner.js";

export interface PatrolRunner {
  run(taskId: string): Promise<void>;
}

export function createRunner(db: AppDatabase): PatrolRunner {
  if (process.env.PATROL_RUNNER === "pi") {
    return new PiPatrolRunner(db);
  }
  return new LocalPatrolRunner(db);
}
