"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getWorkspaces } from "@/lib/api";
import { WorkspaceCard } from "@/components/WorkspaceCard";
import { CreateWorkspaceDialog } from "@/components/CreateWorkspaceDialog";
import { LogoutButton } from "@/components/LogoutButton";
import { PendingInvites } from "@/components/PendingInvites";
import { Workspace } from "@/types";
import Link from "next/link";
import { Loader2, LogIn, AlertCircle, MessagesSquare, FolderOpen, Settings } from "lucide-react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";

export default function Dashboard() {
  const router = useRouter();
  const { data: session } = useSession();
  const userName = session?.user?.name || session?.user?.email?.split("@")[0] || "there";
  const initials = userName.slice(0, 2).toUpperCase();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorType, setErrorType] = useState<"UNAUTHORIZED" | "CONNECTION_FAILED" | "OTHER" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadWorkspaces = useCallback(() => {
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

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-transparent">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent p-8 relative">
      <div className="watermark" aria-hidden>Workspaces</div>
      <div className="max-w-2xl mx-auto space-y-6 relative z-10">
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-lg font-bold text-white shadow-[0_10px_24px_-10px_rgba(107,70,232,0.7)]">
              {initials}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold tracking-tight text-slate-50">Hi, {userName}</h1>
              <p className="text-sm text-slate-400">Welcome back</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {errorType !== "UNAUTHORIZED" && (
              <Link href="/messages" aria-label="Messages" title="Messages" className="flex size-11 items-center justify-center rounded-full bg-white text-slate-50 shadow-[0_8px_20px_-12px_rgba(107,70,232,0.5)] transition-colors hover:text-indigo-500">
                <MessagesSquare className="size-5" />
              </Link>
            )}
            <Link href="/settings" aria-label="Account settings" title="Account settings" className="flex size-11 items-center justify-center rounded-full bg-white text-slate-50 shadow-[0_8px_20px_-12px_rgba(107,70,232,0.5)] transition-colors hover:text-indigo-500">
              <Settings className="size-5" />
            </Link>
            <LogoutButton variant="outline" showText={false} className="size-11 rounded-full border-transparent bg-white text-slate-50 shadow-[0_8px_20px_-12px_rgba(107,70,232,0.5)] hover:text-red-400" />
          </div>
        </header>

        {!errorType && <PendingInvites onAccepted={loadWorkspaces} />}

        {!errorType && (
          <section className="rounded-[2rem] bg-indigo-950/70 p-5 shadow-[0_10px_30px_-18px_rgba(107,70,232,0.5)] md:p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-xl font-bold text-slate-50">Your workspaces</h2>
              <CreateWorkspaceDialog />
            </div>
            <div className="mt-5 grid grid-cols-3 gap-3 sm:gap-4">
              {[
                { label: "Workspaces", value: workspaces.length, active: true },
                { label: "Members", value: workspaces.reduce((n, w) => n + (w.member_count || 0), 0), active: false },
                { label: "Sources", value: workspaces.reduce((n, w) => n + (w.source_count || 0), 0), active: false },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className={`rounded-2xl px-3 py-3 text-center ${stat.active ? "bg-indigo-600 text-white shadow-[0_10px_24px_-10px_rgba(107,70,232,0.8)]" : "bg-white text-slate-50"}`}
                >
                  <div className={`text-xs ${stat.active ? "text-white/80" : "text-slate-400"}`}>{stat.label}</div>
                  <div className="mt-1 text-xl font-bold">{stat.value}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {errorType === "UNAUTHORIZED" && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 text-center max-w-md mx-auto space-y-4 my-12 shadow-2xl">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
              <LogIn className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-semibold text-slate-50">Authentication Required</h3>
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
              <div className="rounded-[2rem] bg-white py-16 text-center shadow-[0_10px_30px_-18px_rgba(107,70,232,0.5)]">
                <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400">
                  <FolderOpen className="size-7" />
                </div>
                <h3 className="text-lg font-medium text-slate-50 mb-2">No workspaces found</h3>
                <p className="text-slate-400 text-sm max-w-sm mx-auto mb-6">You don&apos;t belong to any workspaces yet. Create one to get started.</p>
                <CreateWorkspaceDialog />
              </div>
            ) : (
              <div className="space-y-3">
                {workspaces.map((ws, i) => (
                  <WorkspaceCard key={ws.id} workspace={ws} role="owner" index={i} />
                ))}
              </div>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
