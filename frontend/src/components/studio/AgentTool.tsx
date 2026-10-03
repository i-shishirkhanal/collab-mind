"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Zap, CheckCircle2, Circle } from "lucide-react";
import { triggerStudyCoach, getAgentStatus, approveAgent, getLatestAgentRun } from "@/lib/api";

type AgentStatus = 'analyzing' | 'planning' | 'awaiting_approval' | 'generating' | 'done' | 'failed';

/** The service stores 'started' and 'completed'; the tracker uses 'analyzing' and 'done'. */
const toUiStatus = (s: string): AgentStatus =>
  s === "completed" ? "done" : s === "started" ? "analyzing" : (s as AgentStatus);

export function AgentTool({ workspaceId }: { workspaceId: string }) {
  const [goal, setGoal] = useState("");
  const [runId, setRunId] = useState<string | null>(null);

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [plan, setPlan] = useState<unknown>(null);
  const [materials, setMaterials] = useState<string | null>(null);

  // Pick up the workspace's latest run again after a refresh (finished, or still in progress).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { run_id } = await getLatestAgentRun(workspaceId);
        if (!run_id || cancelled) return;
        const data = await getAgentStatus(workspaceId, run_id);
        if (cancelled) return;
        setRunId(run_id);
        setStatus(toUiStatus(data.status));
        if (data.plan) setPlan(data.plan);
        if (data.materials) setMaterials(data.materials);
      } catch {
        // nothing to resume, or offline: start empty
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  const startAgent = async () => {
    if (!goal) return;
    setStatus("analyzing");
    setPlan(null);
    setMaterials(null);
    try {
      const { run_id } = await triggerStudyCoach(workspaceId, goal);
      setRunId(run_id);
    } catch (err) {
      console.error(err);
      setStatus("failed");
    }
  };

  const handleApprove = async () => {
    if (!runId) return;
    try {
      setStatus("generating"); // optimistically jump
      await approveAgent(workspaceId, runId);
    } catch (err) {
      console.error(err);
    }
  };

  // Poll agent status
  useEffect(() => {
    let timer: NodeJS.Timeout;
    
    const checkStatus = async () => {
      if (!runId || status === "done" || status === "failed") return;
      try {
        const data = await getAgentStatus(workspaceId, runId);
        setStatus(toUiStatus(data.status));
        if (data.plan) {
           setPlan(data.plan);
        }
        if (data.materials) setMaterials(data.materials);
      } catch (err) {
        console.error("Polling error", err);
      }
    };

    if (runId && status !== "done" && status !== "failed") {
      timer = setInterval(checkStatus, 3000);
    }
    
    return () => clearInterval(timer);
  }, [runId, status, workspaceId]);

  const steps = [
    { id: "analyzing", label: "Analyzing Sources" },
    { id: "planning", label: "Building Action Plan" },
    { id: "awaiting_approval", label: "Awaiting Your Approval" },
    { id: "generating", label: "Executing Agent Tools" },
    { id: "done", label: "Agent Run Complete" },
  ];

  const getStepState = (stepId: string) => {
    if (status === "failed") return "failed";
    if (status === "done") return "done";
    const idx = steps.findIndex(s => s.id === stepId);
    const currIdx = steps.findIndex(s => s.id === status);
    
    if (status === null) return "pending";
    if (idx < currIdx) return "done";
    if (idx === currIdx) return "active";
    return "pending";
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center border border-purple-500/20">
            <Zap className="w-5 h-5 text-purple-400" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-slate-50">Study Coach Agent</h2>
            <p className="text-xs text-slate-500">Autonomous multi-step learning planner</p>
          </div>
        </div>
        
        <div className="space-y-4 max-w-xl">
          <div className="space-y-2">
            <Label className="text-slate-300">Agent Goal</Label>
            <Input 
              placeholder="e.g. Create a comprehensive learning path for React hooks" 
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              disabled={status !== null && status !== "done" && status !== "failed"}
              className="bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500"
            />
          </div>
          
          <Button 
            onClick={startAgent} 
            disabled={!goal || (status !== null && status !== "done" && status !== "failed")}
            className="bg-purple-600 hover:bg-purple-700 text-white w-full md:w-auto"
          >
            {status !== null && status !== "done" && status !== "failed" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Zap className="w-4 h-4 mr-2" />}
            {status !== null && status !== "done" && status !== "failed" ? "Agent is Running" : "Deploy Coach"}
          </Button>

          {status === "failed" && <p className="text-red-400 text-sm mt-2">Agent run failed to execute.</p>}
        </div>
      </div>

      {status && status !== "failed" && (
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-sm">
          <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-6 flex justify-between">
            <span>Agent Tracker</span>
            <span className="text-indigo-400 truncate max-w-[200px] normal-case lowercase">{runId}</span>
          </h3>
          
          <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-slate-700">
            {steps.map((step) => {
              const state = getStepState(step.id);
              return (
                <div key={step.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                  <div className={`flex z-10 items-center justify-center w-10 h-10 rounded-full border-4 shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 ${
                    state === "done" ? "bg-emerald-500 border-emerald-900 text-emerald-100" :
                    state === "active" ? "bg-purple-600 border-purple-900 text-white animate-pulse" :
                    "bg-slate-800 border-slate-700 text-slate-500"
                  }`}>
                    {state === "done" ? <CheckCircle2 className="w-5 h-5" /> : 
                     state === "active" ? <Loader2 className="w-5 h-5 animate-spin" /> : 
                     <Circle className="w-4 h-4" />}
                  </div>
                  <div className={`w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-4 rounded-xl border ${
                    state === "active" ? "bg-slate-900 border-purple-500/50 shadow-lg" : "bg-slate-900/50 border-slate-800"
                  }`}>
                    <h4 className={`font-semibold ${state === "active" ? "text-purple-400" : state === "done" ? "text-slate-200" : "text-slate-500"}`}>
                      {step.label}
                    </h4>

                    {/* Show execution Plan JSON if available at planning/approval phase */}
                    {step.id === "planning" && plan != null && (state === "done" || state === "active") && (
                       <pre className="mt-3 bg-slate-950 p-3 rounded text-xs text-slate-400 overflow-x-auto border border-slate-800">
                         {JSON.stringify(plan, null, 2)}
                       </pre>
                    )}

                    {step.id === "done" && state === "done" && materials && (
                       <pre className="mt-3 bg-slate-950 p-3 rounded text-xs text-slate-300 whitespace-pre-wrap overflow-x-auto border border-slate-800 max-h-96 overflow-y-auto">
                         {materials}
                       </pre>
                    )}

                    {step.id === "awaiting_approval" && state === "active" && (
                      <div className="mt-4 flex gap-3">
                        <Button size="sm" onClick={handleApprove} className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/20 font-medium">
                          <CheckCircle2 className="w-4 h-4 mr-1.5"/> Approve Execution
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setStatus("failed")} className="border-slate-600 text-slate-300">
                          Reject
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
