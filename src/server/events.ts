import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { taskEventsPath } from "./paths.js";
import type { TaskEvent } from "./types.js";

class EventBus {
  private readonly emitter = new EventEmitter();

  async emitTaskEvent(event: Omit<TaskEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<TaskEvent> {
    const complete: TaskEvent = {
      ...event,
      id: event.id ?? randomUUID(),
      createdAt: event.createdAt ?? new Date().toISOString()
    };
    const eventsPath = taskEventsPath(complete.taskId);
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    await fs.appendFile(eventsPath, `${JSON.stringify(complete)}\n`, "utf8");
    this.emitter.emit(complete.taskId, complete);
    return complete;
  }

  async history(taskId: string): Promise<TaskEvent[]> {
    try {
      const content = await fs.readFile(taskEventsPath(taskId), "utf8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TaskEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    this.emitter.on(taskId, listener);
    return () => this.emitter.off(taskId, listener);
  }
}

export const eventBus = new EventBus();
