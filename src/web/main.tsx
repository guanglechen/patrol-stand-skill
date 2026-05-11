import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Bot, CheckCircle2, FileSpreadsheet, Play, Send, UploadCloud } from "lucide-react";
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
              <Activity size={18} />
              <span>运行详情</span>
            </div>
            <div className="event-stream">
              {events.map((event) => (
                <div key={event.id} className={`event-card ${event.level ?? "info"}`}>
                  <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                  <strong>{event.stage ?? event.tool ?? event.type}</strong>
                  <span>{event.message}</span>
                </div>
              ))}
            </div>
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
