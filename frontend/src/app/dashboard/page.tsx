"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getWorkspaces } from "@/lib/api";
import { WorkspaceCard } from "@/components/WorkspaceCard";
import { CreateWorkspaceDialog } from "@/components/CreateWorkspaceDialog";
import { LogoutButton } from "@/components/LogoutButton";
import { Workspace } from "@/types";
import { Loader2, LogIn, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Dashboard() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorType, setErrorType] = useState<"UNAUTHORIZED" | "CONNECTION_FAILED" | "OTHER" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    getWorkspaces()
      .then((data) => {
        setWorkspaces(data.workspaces || data || []);
      })
      .catch((err) => {
        console.warn("Failed to fetch workspaces:", err.message);
        if (err.message === "UNAUTHORIZED") {
          setErrorType("UNAUTHORIZED");
        } else if (err.message === "CONNECTION_FAILED") {
          setErrorType("CONNECTION_FAILED");
          setErrorMessage("Could not connect to backend server on port 4000. Please ensure Docker container or backend process is running.");
        } else {
          setErrorType("OTHER");
          setErrorMessage(err.message);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex items-center justify-between pb-6 border-b border-slate-800/60">
          <div>
            <h1 className="text-3xl font-serif font-semibold text-white tracking-tight">Workspaces</h1>
            <p className="text-slate-400 mt-2 text-sm">Select a workspace to enter CollabMind.</p>
          </div>
          <div className="flex items-center gap-3">
            {errorType !== "UNAUTHORIZED" && <CreateWorkspaceDialog />}
            <LogoutButton variant="outline" className="border-slate-800 text-slate-300 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/20" />
          </div>
        </header>

        {errorType === "UNAUTHORIZED" && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 text-center max-w-md mx-auto space-y-4 my-12 shadow-2xl">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
              <LogIn className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-semibold text-white">Authentication Required</h3>
              <p className="text-sm text-slate-400">Please sign in to access your AI research workspaces.</p>
            </div>
            <Button
              onClick={() => router.push("/auth/signin")}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-6 h-10 rounded-xl transition-all shadow-lg shadow-indigo-600/25"
            >
              Sign In Now
            </Button>
          </div>
        )}

        {errorType === "CONNECTION_FAILED" && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-amber-400 text-sm flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Backend Server Unavailable</p>
              <p className="text-amber-500/80 mt-1">{errorMessage}</p>
            </div>
          </div>
        )}

        {errorType === "OTHER" && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-red-400 text-sm flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Error Loading Workspaces</p>
              <p className="text-red-500/80 mt-1">{errorMessage}</p>
            </div>
          </div>
        )}

        {!errorType && (
          <main>
            {workspaces.length === 0 ? (
              <div className="text-center py-20 border-2 border-dashed border-slate-800 rounded-2xl bg-slate-900/50">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-800 mb-4 text-slate-400">
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                </div>
                <h3 className="text-lg font-medium text-white mb-2">No workspaces found</h3>
                <p className="text-slate-400 text-sm max-w-sm mx-auto mb-6">You don&apos;t belong to any workspaces yet. Create one to get started.</p>
                <CreateWorkspaceDialog />
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {workspaces.map(ws => (
                  <WorkspaceCard key={ws.id} workspace={ws} role="owner" />
                ))}
              </div>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
