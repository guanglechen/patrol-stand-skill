import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  FileSpreadsheet,
  Layers3,
  Play,
  Send,
  TerminalSquare,
  UploadCloud
} from "lucide-react";
import "./styles.css";

type TaskStatus = "draft" | "running" | "waiting_user" | "completed" | "failed";

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  waitingAskId?: string | null;
  createdAt: string;
}

interface TaskEvent {
  id: string;
  taskId: string;
  type: string;
  message: string;
  createdAt: string;
  level?: "info" | "warning" | "error" | "success";
  stage?: string;
  tool?: string;
  ask?: AgentAsk;
  artifact?: Artifact;
}

interface AgentAsk {
  id: string;
  title: string;
  body: string;
  inputKind: "single_select" | "multi_select" | "text" | "attachment";
  required: boolean;
  options?: Array<{ label: string; value: string; description?: string; recommended?: boolean }>;
  defaultValue?: string | string[];
}

interface Artifact {
  id: string;
  taskId: string;
  label: string;
  kind: string;
  size: number;
  downloadUrl?: string;
}

interface TaskDetails {
  task: Task;
  files: Array<{ id: string; originalName: string; size: number }>;
  messages: Array<{ id: string; role: string; content: string; askId?: string | null }>;
  artifacts: Artifact[];
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [details, setDetails] = useState<TaskDetails | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("巡检标准分析任务");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const latestAsk = useMemo(() => {
    return [...events].reverse().find((event) => event.type === "agent_ask")?.ask;
  }, [events]);

  const stageItems = useMemo(() => buildStageItems(events), [events]);
  const visibleRunEvents = useMemo(() => events.filter(isNarrativeEvent).slice(-3), [events]);
  const toolEvents = useMemo(() => events.filter(isToolEvent).slice(-6), [events]);
  const workbookArtifact = useMemo(
    () => details?.artifacts.find((artifact) => artifact.kind === "workbook"),
    [details?.artifacts]
  );

  useEffect(() => {
    void refreshTasks();
  }, []);

  useEffect(() => {
    if (!activeTaskId) return;
    void refreshDetails(activeTaskId);
    setEvents([]);
    const source = new EventSource(`/api/tasks/${activeTaskId}/events`);
    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as TaskEvent;
      setEvents((current) => {
        if (current.some((item) => item.id === next.id)) return current;
        return [...current, next];
      });
      if (["artifact_ready", "task_completed", "task_failed", "agent_ask"].includes(next.type)) {
        void refreshDetails(activeTaskId);
        void refreshTasks();
      }
    };
    return () => source.close();
  }, [activeTaskId]);

  async function refreshTasks() {
    const response = await fetch("/api/tasks");
    const data = (await response.json()) as Task[];
    setTasks(data);
    if (!activeTaskId && data[0]) setActiveTaskId(data[0].id);
  }

  async function refreshDetails(taskId: string) {
    const response = await fetch(`/api/tasks/${taskId}`);
    if (response.ok) setDetails((await response.json()) as TaskDetails);
  }

  async function createTask() {
    setBusy(true);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, message })
      });
      const task = (await response.json()) as Task;
      setActiveTaskId(task.id);
      setMessage("");
      await refreshTasks();
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles() {
    if (!activeTaskId || !fileRef.current?.files?.length) return;
    const form = new FormData();
    Array.from(fileRef.current.files).forEach((file) => form.append("files", file));
    await fetch(`/api/tasks/${activeTaskId}/files`, { method: "POST", body: form });
    fileRef.current.value = "";
    await refreshDetails(activeTaskId);
  }

  async function sendMessage() {
    if (!activeTaskId || !message.trim()) return;
    await fetch(`/api/tasks/${activeTaskId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message.trim() })
    });
    setMessage("");
    await refreshDetails(activeTaskId);
  }

  async function answerAsk(ask: AgentAsk) {
    if (!activeTaskId) return;
    const selected =
      ask.inputKind === "single_select"
        ? answer || String(ask.defaultValue ?? "")
        : ask.inputKind === "multi_select"
          ? answer
          : ask.inputKind === "attachment"
            ? "attachments_uploaded"
            : answer;
    await fetch(`/api/tasks/${activeTaskId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ askId: ask.id, content: selected })
    });
    setAnswer("");
    await fetch(`/api/tasks/${activeTaskId}/run`, { method: "POST" });
  }

  async function runTask() {
    if (!activeTaskId) return;
    await fetch(`/api/tasks/${activeTaskId}/run`, { method: "POST" });
  }

  return (
    <main className="app-shell">
      <aside className="task-rail">
        <div className="brand-block">
          <Bot size={28} />
          <div>
            <p>PI PATROL AGENT</p>
            <h1>巡检标准分析</h1>
          </div>
        </div>
        <label className="field-label">任务名称</label>
        <input className="title-input" value={title} onChange={(event) => setTitle(event.target.value)} />
        <button className="primary wide" onClick={createTask} disabled={busy}>
          <Send size={16} />
          新建任务
        </button>
        <div className="task-list">
          {tasks.map((task) => (
            <button
              key={task.id}
              className={task.id === activeTaskId ? "task-row active" : "task-row"}
              onClick={() => setActiveTaskId(task.id)}
            >
              <span>{task.title}</span>
              <small>{statusLabel(task.status)}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="workbench">
        <header className="topbar">
          <div>
            <p>本地 Docker 沙箱 · Pi skill package · Excel 输出</p>
            <h2>{details?.task.title ?? "等待创建任务"}</h2>
          </div>
          <button className="primary" onClick={runTask} disabled={!activeTaskId}>
            <Play size={16} />
            启动/继续
          </button>
        </header>

        <div className="content-grid">
          <section className="panel conversation">
            <div className="panel-title">
              <Activity size={18} />
              <span>输入与交互</span>
            </div>
            <div className="composer">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="输入巡检场景、组织职责、标准材料说明，或运行中补充信息"
              />
              <div className="composer-actions">
                <input ref={fileRef} type="file" multiple />
                <button onClick={uploadFiles} disabled={!activeTaskId}>
                  <UploadCloud size={16} />
                  上传附件
                </button>
                <button onClick={sendMessage} disabled={!activeTaskId || !message.trim()}>
                  <Send size={16} />
                  发送文本
                </button>
              </div>
            </div>

            {visibleRunEvents.length ? (
              <div className="live-feed" aria-live="polite">
                <div className="feed-header">
                  <Bot size={16} />
                  <span>Agent 最近输出</span>
                </div>
                {visibleRunEvents.map((event) => (
                  <div key={event.id} className={`feed-line ${event.level ?? "info"}`}>
                    <span>{formatEventTime(event.createdAt)}</span>
                    <p>{displayEventMessage(event)}</p>
                  </div>
                ))}
              </div>
            ) : null}

            {latestAsk && details?.task.status === "waiting_user" ? (
              <div className="ask-box">
                <strong>{latestAsk.title}</strong>
                <p>{latestAsk.body}</p>
                {latestAsk.inputKind === "single_select" ? (
                  <div className="choice-stack">
                    {latestAsk.options?.map((option) => (
                      <label key={option.value} className="choice">
                        <input
                          type="radio"
                          name="ask"
                          value={option.value}
                          checked={(answer || latestAsk.defaultValue) === option.value}
                          onChange={(event) => setAnswer(event.target.value)}
                        />
                        <span>
                          {option.label}
                          {option.recommended ? <em>推荐</em> : null}
                          <small>{option.description}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : latestAsk.inputKind === "multi_select" ? (
                  <div className="choice-stack">
                    {latestAsk.options?.map((option) => {
                      const selectedValues = answer ? answer.split(",").filter(Boolean) : arrayDefault(latestAsk.defaultValue);
                      return (
                        <label key={option.value} className="choice">
                          <input
                            type="checkbox"
                            value={option.value}
                            checked={selectedValues.includes(option.value)}
                            onChange={(event) => {
                              const next = new Set(selectedValues);
                              if (event.target.checked) next.add(option.value);
                              else next.delete(option.value);
                              setAnswer([...next].join(","));
                            }}
                          />
                          <span>
                            {option.label}
                            {option.recommended ? <em>推荐</em> : null}
                            <small>{option.description}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : latestAsk.inputKind === "attachment" ? (
                  <div className="attachment-ask">
                    <UploadCloud size={18} />
                    <span>请使用上方上传附件控件补充材料，上传后提交继续。</span>
                  </div>
                ) : (
                  <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} />
                )}
                <button className="primary" onClick={() => answerAsk(latestAsk)}>
                  <CheckCircle2 size={16} />
                  提交并继续
                </button>
              </div>
            ) : null}

            <div className="material-list">
              <h3>材料</h3>
              {details?.files.map((file) => (
                <div className="material-row" key={file.id}>
                  <span>{file.originalName}</span>
                  <small>{formatBytes(file.size)}</small>
                </div>
              ))}
            </div>
          </section>

          <section className="panel event-panel">
            <div className="panel-title">
              <Layers3 size={18} />
              <span>Agent 运行</span>
            </div>
            <div className="run-summary">
              <div>
                <small>当前状态</small>
                <strong>{details ? statusLabel(details.task.status) : "未选择任务"}</strong>
              </div>
              <div>
                <small>事件</small>
                <strong>{events.length}</strong>
              </div>
              <div>
                <small>产物</small>
                <strong>{details?.artifacts.length ?? 0}</strong>
              </div>
            </div>

            <div className="stage-timeline">
              {stageItems.length ? (
                stageItems.map((item) => (
                  <div key={item.key} className={`stage-item ${item.status}`}>
                    <span className="stage-marker">{stageIcon(item.status)}</span>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.message}</small>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">任务启动后会显示阶段轨迹。</div>
              )}
            </div>

            {workbookArtifact ? (
              <a className="workbook-callout" href={workbookArtifact.downloadUrl}>
                <FileSpreadsheet size={18} />
                <span>
                  <strong>巡检标准工作簿已生成</strong>
                  <small>{formatBytes(workbookArtifact.size)}</small>
                </span>
                <ChevronRight size={16} />
              </a>
            ) : null}

            <details className="tool-drawer">
              <summary>
                <TerminalSquare size={16} />
                <span>底层工具与沙箱命令</span>
                <small>{events.filter(isToolEvent).length} 条</small>
              </summary>
              <div className="tool-list">
                {toolEvents.length ? (
                  toolEvents.map((event) => (
                    <div key={event.id} className={`tool-line ${event.level ?? "info"}`}>
                      <time>{formatEventTime(event.createdAt)}</time>
                      <code>{event.tool ?? event.type}</code>
                      <span>{compactToolMessage(event.message)}</span>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">暂无工具调用。</div>
                )}
              </div>
            </details>
          </section>

          <section className="panel artifacts">
            <div className="panel-title">
              <FileSpreadsheet size={18} />
              <span>Excel 产物</span>
            </div>
            {details?.artifacts.map((artifact) => (
              <a className="artifact-row" key={artifact.id} href={artifact.downloadUrl}>
                <span>{artifact.label}</span>
                <small>{artifact.kind} · {formatBytes(artifact.size)}</small>
              </a>
            ))}
          </section>
        </div>
      </section>
    </main>
  );
}

function statusLabel(status: TaskStatus) {
  const labels: Record<TaskStatus, string> = {
    draft: "待运行",
    running: "运行中",
    waiting_user: "等待确认",
    completed: "完成",
    failed: "失败"
  };
  return labels[status];
}

interface StageItem {
  key: string;
  label: string;
  message: string;
  status: "running" | "completed" | "failed" | "pending";
}

const stageOrder = ["intake", "material_parse", "boundary_design", "workbook_build"];
const stageLabels: Record<string, string> = {
  intake: "材料接收",
  material_parse: "材料解析",
  boundary_design: "职责边界与对象设计",
  workbook_build: "Excel 工作簿生成"
};

function buildStageItems(events: TaskEvent[]): StageItem[] {
  const seen = new Map<string, StageItem>();
  for (const event of events) {
    if (!event.stage) continue;
    if (!seen.has(event.stage)) {
      seen.set(event.stage, {
        key: event.stage,
        label: stageLabels[event.stage] ?? event.stage,
        message: "等待开始",
        status: "pending"
      });
    }
    const current = seen.get(event.stage)!;
    if (event.type === "stage_started") {
      current.status = "running";
      current.message = event.message;
    }
    if (event.type === "stage_completed") {
      current.status = "completed";
      current.message = event.message;
    }
    if (event.type === "task_failed") {
      current.status = "failed";
      current.message = event.message;
    }
  }
  return [...seen.values()].sort((a, b) => stageOrder.indexOf(a.key) - stageOrder.indexOf(b.key));
}

function isToolEvent(event: TaskEvent) {
  return event.type.startsWith("tool_");
}

function isNarrativeEvent(event: TaskEvent) {
  if (isToolEvent(event)) return false;
  return [
    "run_started",
    "stage_started",
    "stage_completed",
    "agent_ask",
    "user_answered",
    "artifact_ready",
    "task_completed",
    "task_failed"
  ].includes(event.type);
}

function displayEventMessage(event: TaskEvent) {
  if (event.type === "artifact_ready" && event.artifact) return `产物就绪：${event.artifact.label}`;
  if (event.type === "agent_ask" && event.ask) return `需要确认：${event.ask.title}`;
  return event.message;
}

function compactToolMessage(message: string) {
  return message.replace(/\s+/g, " ").slice(0, 150);
}

function formatEventTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function stageIcon(status: StageItem["status"]) {
  if (status === "completed") return <CheckCircle2 size={15} />;
  if (status === "failed") return <AlertCircle size={15} />;
  if (status === "running") return <Activity size={15} />;
  return <CircleDot size={15} />;
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function arrayDefault(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value) return [value];
  return [];
}

createRoot(document.getElementById("root")!).render(<App />);
