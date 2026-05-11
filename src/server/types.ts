export type TaskStatus =
  | "draft"
  | "running"
  | "waiting_user"
  | "completed"
  | "failed";

export type TaskEventType =
  | "task_created"
  | "message_added"
  | "file_uploaded"
  | "run_started"
  | "stage_started"
  | "stage_completed"
  | "tool_started"
  | "tool_completed"
  | "tool_failed"
  | "agent_ask"
  | "user_answered"
  | "artifact_ready"
  | "task_completed"
  | "task_failed";

export type AskInputKind = "single_select" | "multi_select" | "text" | "attachment";

export interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  waitingAskId?: string | null;
}

export interface TaskFile {
  id: string;
  taskId: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
}

export interface TaskMessage {
  id: string;
  taskId: string;
  role: "user" | "agent" | "system";
  content: string;
  askId?: string | null;
  createdAt: string;
}

export interface TaskArtifact {
  id: string;
  taskId: string;
  label: string;
  kind: "workbook" | "trace" | "validation" | "manifest" | "other";
  path: string;
  size: number;
  createdAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  message: string;
  createdAt: string;
  level?: "info" | "warning" | "error" | "success";
  stage?: string;
  tool?: string;
  ask?: AgentAsk;
  artifact?: TaskArtifact;
  data?: Record<string, unknown>;
}

export interface AgentAsk {
  id: string;
  title: string;
  body: string;
  inputKind: AskInputKind;
  required: boolean;
  options?: Array<{
    label: string;
    value: string;
    description?: string;
    recommended?: boolean;
  }>;
  defaultValue?: string | string[];
}

export interface TaskManifest {
  task: TaskRecord;
  files: TaskFile[];
  messages: TaskMessage[];
  answers: TaskMessage[];
}
