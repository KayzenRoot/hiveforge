"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Health = { status: string; codex: { available: boolean; version: string | null; appServer: boolean; authentication: string; reason?: string } };
type Validation = { kind: string; command: string | null; status: string; exitCode: number | null; stdout: string; stderr: string };
type RunOverview = { run: { id: string; workOrderId: string; state: string; autonomyMode: string; iterationCount: number; progressPercent: number; currentBlocker: string | null; runBaseSha: string | null; runBaseBranch: string | null; expectedBaseSha: string | null; expectedHeadSha: string | null; lastReviewStatus: string | null; lastReviewVerdict: string | null; lastReviewSummary: string | null; lastCheckpointNote: string | null; updatedAt: string }; gitEvidence: { baseSha: string; headSha: string; branch: string; status: string; isClean: boolean; changedFiles: string[]; diffSummary: string } | null; validations: Validation[]; review: { status: string; review: { reviewId: string; verdict: string; summary: string; progressPercent: number; checkpointNote: string } } | null };
type Project = { id: string; name: string; localPath: string; autonomyMode: string; workingBranch: string; reviewMailboxPath: string; latestRun?: RunOverview };
type RunEvent = { id: string; type: string; state: string | null; message: string; createdAt: string };

const modeCopy: Record<string, string> = {
  AUTONOMOUS: "Autonomous",
  GUARDED: "Guarded",
  CONTROLLED: "Controlled"
};

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ name: "", localPath: "", defaultBranch: "main", workingBranch: "main", testCommand: "npm test", autonomyMode: "AUTONOMOUS", reviewMailboxPath: "" });

  const selected = useMemo(() => projects.find((project) => project.id === selectedId) ?? projects[0], [projects, selectedId]);
  const overview = selected?.latestRun;
  const latestRun = overview?.run;

  const load = useCallback(async () => {
    const [projectsResponse, healthResponse] = await Promise.all([fetch("/api/projects"), fetch("/api/health")]);
    const projectPayload = await projectsResponse.json() as { projects: Project[] };
    setProjects(projectPayload.projects);
    setHealth(await healthResponse.json() as Health);
    if (!selectedId && projectPayload.projects[0]) setSelectedId(projectPayload.projects[0].id);
  }, [selectedId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!latestRun?.id) {
      setEvents([]);
      return;
    }
    let source: EventSource | null = null;
    void fetch(`/api/events?runId=${latestRun.id}`).then((response) => response.json()).then((payload: { events: RunEvent[] }) => setEvents(payload.events));
    source = new EventSource(`/api/events?runId=${latestRun.id}&stream=1`);
    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as RunEvent;
      setEvents((current) => current.some((item) => item.id === next.id) ? current : [...current, next].slice(-80));
      void load();
    };
    return () => source?.close();
  }, [latestRun?.id, load]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, reviewMailboxPath: form.reviewMailboxPath || undefined }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setMessage(payload.error ?? "Could not register project"); return; }
    setShowForm(false);
    setForm({ name: "", localPath: "", defaultBranch: "main", workingBranch: "main", testCommand: "npm test", autonomyMode: "AUTONOMOUS", reviewMailboxPath: "" });
    setMessage("Project registered");
    await load();
  }

  async function startRun() {
    if (!selected) return;
    setMessage("");
    const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: selected.id, prompt: "Inspect the repository, implement the next safe increment, run validation, and report evidence." }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setMessage(payload.error ?? "Could not start run"); return; }
    setMessage("Run dispatched");
    await load();
  }

  async function controlRun(action: "pause" | "resume" | "stop") {
    if (!latestRun) return;
    const response = await fetch("/api/runs/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: latestRun.id, action }) });
    const payload = await response.json() as { error?: string };
    const label = action === "pause" ? "paused" : action === "resume" ? "resumed" : "stopped";
    setMessage(response.ok ? `Run ${label}` : payload.error ?? "Could not control run");
    await load();
  }

  const healthLabel = health?.status === "READY" ? "Codex ready to connect" : "Codex not configured";
  const status = latestRun?.state ?? "IDLE";

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark">⌁</span><div><strong>HIVEFORGE</strong><span>closed-loop control room</span></div></div>
        <div className="topbar-actions"><span className={`health-dot ${health?.codex.available ? "is-good" : "is-warn"}`} /> <span>{healthLabel}</span><button className="icon-button" aria-label="Refresh" onClick={() => void load()}>↻</button></div>
      </header>

      <section className="hero-grid">
        <div className="hero-copy"><p className="eyebrow">LOCAL-FIRST ORCHESTRATION / V0.1</p><h1>Make the next move<br /><em>provable.</em></h1><p className="hero-subtitle">A quiet control surface for Codex runs, Git evidence, and the reviews that unlock the next dispatch.</p></div>
        <div className="hero-signal"><span className="signal-label">LOOP SIGNAL</span><div className="signal-line"><i /><i /><i /><i /><i /></div><strong>{latestRun ? `${latestRun.iterationCount.toString().padStart(2, "0")} / LOOP` : "-- / STANDBY"}</strong><small>{selected ? `tracking ${selected.name}` : "register a project to begin"}</small></div>
      </section>

      <section className="workspace-grid">
        <aside className="panel projects-panel"><div className="panel-heading"><div><p className="eyebrow">REGISTRY</p><h2>Projects</h2></div><button className="small-button" onClick={() => setShowForm((value) => !value)}>+ Add</button></div>
          {showForm && <form className="project-form" onSubmit={createProject}><input required placeholder="Project name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><input required placeholder="Absolute local path" value={form.localPath} onChange={(e) => setForm({ ...form, localPath: e.target.value })} /><input placeholder="Mailbox path (optional)" value={form.reviewMailboxPath} onChange={(e) => setForm({ ...form, reviewMailboxPath: e.target.value })} /><select value={form.autonomyMode} onChange={(e) => setForm({ ...form, autonomyMode: e.target.value })}><option>AUTONOMOUS</option><option>GUARDED</option><option>CONTROLLED</option></select><button className="primary-button" type="submit">Register project</button></form>}
          <div className="project-list">{projects.length === 0 ? <div className="empty-state"><span>◎</span><strong>No local projects yet</strong><p>Register a Git repository to give the loop a home.</p></div> : projects.map((project) => <button className={`project-card ${selected?.id === project.id ? "is-selected" : ""}`} key={project.id} onClick={() => setSelectedId(project.id)}><span className="project-glyph">{project.name.slice(0, 1).toUpperCase()}</span><span className="project-card-copy"><strong>{project.name}</strong><small>{project.localPath}</small></span><span className="project-state">{project.latestRun?.run.state ?? "READY"}</span></button>)}</div>
        </aside>

        <div className="main-column"><section className="panel run-panel"><div className="panel-heading"><div><p className="eyebrow">ACTIVE WORK ORDER</p><h2>{selected ? selected.name : "No project selected"}</h2></div><span className={`status-pill status-${status.toLowerCase()}`}><i />{status}</span></div><div className="run-meta"><div><span>Autonomy</span><strong>{selected ? modeCopy[selected.autonomyMode] : "—"}</strong></div><div><span>Branch</span><strong>{latestRun?.runBaseBranch ?? selected?.workingBranch ?? "—"}</strong></div><div><span>Work order</span><strong>{latestRun?.workOrderId ?? "Awaiting run"}</strong></div></div><div className="run-actions"><button className="primary-button" disabled={!selected || health?.status !== "READY" || Boolean(latestRun && !["COMPLETE", "FAILED", "BLOCKED"].includes(latestRun.state))} onClick={() => void startRun()}>Start run <span>↗</span></button><button disabled={!latestRun || !["QUEUED", "CODEX_RUNNING", "WAITING_REVIEW", "WAITING_APPROVAL"].includes(status)} onClick={() => void controlRun("pause")}>Pause</button><button disabled={!latestRun || status !== "PAUSED"} onClick={() => void controlRun("resume")}>Resume</button><button disabled={!latestRun || ["COMPLETE", "FAILED"].includes(status)} onClick={() => void controlRun("stop")}>Stop</button></div>{overview && <div className="evidence-strip"><div><span>Git evidence</span><strong>{overview.gitEvidence?.isClean ? "CLEAN" : overview.gitEvidence ? "DIRTY" : "—"}</strong><small>{overview.gitEvidence?.headSha?.slice(0, 12) ?? "not captured"}</small></div><div><span>Validation</span><strong>{overview.validations.length ? overview.validations.map((item) => item.kind + ":" + item.status).join(" · ") : "pending"}</strong><small>{overview.review ? overview.review.status + " / " + overview.review.review.verdict : "review pending"}</small></div><div><span>Progress</span><strong>{latestRun?.progressPercent ?? 0}%</strong><small>{latestRun?.currentBlocker ?? latestRun?.lastCheckpointNote ?? "No active blocker"}</small></div></div>}{message && <p className="inline-message">{message}</p>}</section>
          <section className="panel timeline-panel"><div className="panel-heading"><div><p className="eyebrow">PERSISTED EVENT STREAM</p><h2>Timeline</h2></div><span className="live-badge"><i /> live</span></div><div className="timeline">{events.length === 0 ? <div className="empty-timeline">Events will appear here as the worker moves the run.</div> : events.slice().reverse().map((event) => <div className="timeline-item" key={event.id}><span className="timeline-rail" /><div><div className="timeline-top"><strong>{event.type.replaceAll("_", " ")}</strong><time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><p>{event.message}</p>{event.state && <small>{event.state}</small>}</div></div>)}</div></section></div>
      </section>
      <footer className="footer"><span>HIVEFORGE / runtime truth lives in SQLite</span><span>{health?.codex.version ?? "codex —"} · evidence lock enabled</span></footer>
    </main>
  );
}
