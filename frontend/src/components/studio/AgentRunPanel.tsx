"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useSession } from "next-auth/react";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, Eye, Loader2, ShieldCheck, Wrench, XCircle, Brain, Flag, AlertTriangle } from "lucide-react";
import { approveAgent, rejectAgent, runAgent, getAgentStatus, getAgentSteps, getLatestAgentRun } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useWorkspaceStore } from "@/lib/store";
import type { AgentRunStatus, AgentStep } from "@/types";

export interface AgentDef {
  key: string;
  title: string;
  subtitle: string;
  placeholder: string;
  button: string;
  icon: ComponentType<{ className?: string }>;
}

const ACTIVE = new Set(["running", "awaiting_approval"]);
const POLL_MS = 2500;

const STEP_STYLE: Record<AgentStep["kind"], { label: string; icon: ComponentType<{ className?: string }>; color: string }> = {
  thought: { label: "Thinking", icon: Brain, color: "text-indigo-300" },
  tool_call: { label: "Tool call", icon: Wrench, color: "text-sky-300" },
  observation: { label: "Result", icon: Eye, color: "text-slate-400" },
  approval: { label: "Approval", icon: ShieldCheck, color: "text-amber-300" },
  final: { label: "Answer", icon: Flag, color: "text-emerald-300" },
  error: { label: "Notice", icon: AlertTriangle, color: "text-rose-300" },
};

/**
 * One run panel for every specialist agent: goal input, a live run log that every workspace member can
 * read, an approval checkpoint that only an owner or admin can answer, and the cited result.
 */
export function AgentRunPanel({ workspaceId, agent }: { workspaceId: string; agent: AgentDef }) {
  const { data: session } = useSession();
  const members = useWorkspaceStore((s) => s.members);
  const myRole = members.find((m) => m.user_id === session?.user?.id)?.role;
  // The backend is the authority (403 otherwise); the button is only hidden for plain members.
  const canDecide = myRole !== "member";

  const [goal, setGoal] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRunStatus | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastStepId = useRef(0);
  const logEnd = useRef<HTMLDivElement>(null);

  const reset = () => {
    lastStepId.current = 0;
    setSteps([]);
    setRun(null);
  };

  // Resume the latest run of this agent after a refresh (finished, or still going).
  useEffect(() => {
    let cancelled = false;
    reset();
    setRunId(null);
    setError(null);
    (async () => {
      try {
        const { run_id } = await getLatestAgentRun(workspaceId, agent.key);
        if (!run_id || cancelled) return;
        setRunId(run_id);
      } catch {
        // nothing to resume, or offline: start empty
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, agent.key]);

  const refresh = useCallback(async (id: string) => {
    const [status, stepData] = await Promise.all([
      getAgentStatus(workspaceId, id),
      getAgentSteps(workspaceId, id, lastStepId.current),
    ]);
    const fresh: AgentStep[] = stepData?.steps ?? [];
    if (fresh.length > 0) {
      lastStepId.current = fresh[fresh.length - 1].id;
      setSteps((prev) => [...prev, ...fresh]);
    }
    setRun(status);
    return status as AgentRunStatus;
  }, [workspaceId]);

  // Poll while the run is active (and once when a run is picked up).
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const status = await refresh(runId);
        if (cancelled) return;
        if (ACTIVE.has(status.status) || status.status === "started") timer = setTimeout(tick, POLL_MS);
      } catch {
        if (!cancelled) timer = setTimeout(tick, POLL_MS * 2);
      }
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [runId, refresh]);

  useEffect(() => { logEnd.current?.scrollIntoView({ block: "nearest" }); }, [steps.length]);

  const start = async () => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    reset();
    try {
      const { run_id } = await runAgent(workspaceId, agent.key, goal.trim());
      setRunId(run_id);
    } catch (err) {
      setError(errorMessage(err, "Could not start the agent."));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approve: boolean) => {
    if (!runId) return;
    setError(null);
    try {
      await (approve ? approveAgent(workspaceId, runId) : rejectAgent(workspaceId, runId));
      setRun((r) => (r ? { ...r, status: "running", pending_approval: null } : r));
    } catch (err) {
      setError(errorMessage(err, "Could not record your decision."));
    }
  };

  const active = !!run && ACTIVE.has(run.status);
  const Icon = agent.icon;

  return (
    <div className="space-y-6">
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center border border-purple-500/20">
            <Icon className="w-5 h-5 text-purple-400" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-slate-50">{agent.title}</h2>
            <p className="text-xs text-slate-500">{agent.subtitle}</p>
          </div>
        </div>

        <div className="space-y-4 max-w-xl">
          <div className="space-y-2">
            <Label htmlFor={`goal-${agent.key}`} className="text-slate-300">Goal</Label>
            <Input
              id={`goal-${agent.key}`}
              placeholder={agent.placeholder}
              value={goal}
              maxLength={2000}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") start(); }}
              disabled={active || busy}
              className="bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500"
            />
          </div>
          <Button onClick={start} disabled={!goal.trim() || active || busy} className="bg-purple-600 hover:bg-purple-700 text-white">
            {active || busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Icon className="w-4 h-4 mr-2" />}
            {active ? "Agent is running" : agent.button}
          </Button>
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        </div>
      </div>

      {run && (
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">Run log</h3>
            <span className="text-xs text-slate-500">
              {run.status === "completed" ? "Completed" : run.status === "failed" ? "Failed"
                : run.status === "rejected" ? "Rejected" : run.status === "awaiting_approval" ? "Waiting for approval" : "Working"}
              {" · "}{run.step_count ?? steps.length} steps
            </span>
          </div>
          {run.goal && <p className="text-sm text-slate-300"><span className="text-slate-500">Goal: </span>{run.goal}</p>}

          <ol className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar pr-1" aria-label="Agent steps">
            {steps.map((st) => {
              const meta = STEP_STYLE[st.kind] ?? STEP_STYLE.error;
              const StepIcon = meta.icon;
              return (
                <li key={st.id} className="flex gap-3 rounded-lg bg-slate-900/60 border border-slate-800 p-3">
                  <StepIcon className={`w-4 h-4 mt-0.5 shrink-0 ${meta.color}`} />
                  <div className="min-w-0">
                    <p className={`text-xs font-medium ${meta.color}`}>
                      {meta.label}{st.tool_name ? ` · ${st.tool_name}` : ""}
                    </p>
                    <p className="text-sm text-slate-300 whitespace-pre-wrap break-words line-clamp-6">{st.content}</p>
                  </div>
                </li>
              );
            })}
            {active && run.status === "running" && (
              <li className="flex items-center gap-2 text-xs text-slate-500 px-1"><Loader2 className="w-3 h-3 animate-spin" /> Working…</li>
            )}
            <div ref={logEnd} />
          </ol>

          {run.status === "awaiting_approval" && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
              <p className="text-sm font-medium text-amber-200 flex items-center gap-2"><ShieldCheck className="w-4 h-4" /> Approval needed before the agent continues</p>
              {run.pending_approval && <p className="text-sm text-slate-200 whitespace-pre-wrap">{run.pending_approval}</p>}
              {canDecide ? (
                <div className="flex gap-3">
                  <Button size="sm" onClick={() => decide(true)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                    <CheckCircle2 className="w-4 h-4 mr-1.5" /> Approve
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => decide(false)} className="border-slate-600 text-slate-300">
                    <XCircle className="w-4 h-4 mr-1.5" /> Reject
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-slate-400">Only a workspace owner or admin can approve this step.</p>
              )}
            </div>
          )}

          {(run.status === "failed" || run.status === "rejected") && (
            <p role="alert" className="text-sm text-red-400">{run.message || "The agent run did not finish."}</p>
          )}
        </div>
      )}

      {run?.status === "completed" && run.answer && (
        <div className="bg-slate-800 rounded-2xl border border-slate-700 p-8 shadow-inner space-y-6">
          <div className="prose prose-invert prose-indigo max-w-none">
            {/* Model output built from uploaded documents is untrusted: remote images would be a data-exfiltration channel. */}
            <ReactMarkdown disallowedElements={["img"]} unwrapDisallowed>{run.answer}</ReactMarkdown>
          </div>
          {run.warnings && run.warnings.length > 0 && (
            <ul className="text-xs text-amber-300 space-y-1">{run.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          )}
          {run.citations && run.citations.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">Sources</h4>
              <ul className="space-y-2">
                {run.citations.map((c) => (
                  <li key={`${c.source_id}-${c.chunk_index}`} className="text-sm text-slate-300">
                    <span className="text-indigo-300 font-medium">[{c.index}]</span> {c.source_name}
                    {c.location_label ? ` · ${c.location_label}` : ""}
                    {c.excerpt && <span className="block text-xs text-slate-500 mt-0.5">{c.excerpt}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
