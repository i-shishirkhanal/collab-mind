"use client";

import { use, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare, FileText, MonitorPlay, Users, Loader2, ArrowLeft } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { SocketProvider } from "@/hooks/SocketProvider";
import { usePresenceStore } from "@/lib/store";
import { LogoutButton } from "@/components/LogoutButton";

export default function WorkspaceLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const { id } = resolvedParams;
  const { workspace, members, loading, error } = useWorkspace(id);
  const pathname = usePathname();
  const onlineMembers = usePresenceStore(s => s.onlineMembers);

  const navItems = [
    { name: "Chat", href: `/workspace/${id}/chat`, icon: MessageSquare },
    { name: "Sources", href: `/workspace/${id}/sources`, icon: FileText },
    { name: "Studio", href: `/workspace/${id}/studio`, icon: MonitorPlay },
    { name: "Members", href: `/workspace/${id}/members`, icon: Users },
  ];

  if (loading || !workspace) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-slate-950">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  return (
    <SocketProvider workspaceId={id}>
    <div className="flex h-screen bg-slate-950 overflow-hidden text-slate-50">
      {/* Sidebar - 240px */}
      <aside className="w-[240px] bg-slate-900 border-r border-slate-800/60 hidden md:flex flex-col shrink-0">
        {/* Logo / Header */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-slate-800/60 shrink-0">
          <div className="flex items-center min-w-0 mr-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mr-3 shrink-0">
              <span className="text-indigo-400 font-bold text-sm">CM</span>
            </div>
            <span className="font-semibold text-slate-200 truncate">{workspace.name}</span>
          </div>
          <Link
            href="/dashboard"
            className="text-slate-400 hover:text-slate-200 text-xs px-2 py-1 rounded bg-slate-800 border border-slate-700/80 transition-colors shrink-0 flex items-center gap-1"
            title="Back to Workspaces"
          >
            <ArrowLeft className="w-3 h-3" />
          </Link>
        </div>
        
        {/* Nav Links */}
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-row items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive 
                    ? "bg-indigo-500/10 text-indigo-300" 
                    : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                }`}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                {item.name}
              </Link>
            )
          })}
        </nav>

        {/* Member Avatars & Logout */}
        <div className="p-4 border-t border-slate-800/60 space-y-4">
          <div>
            <div className="text-xs font-medium text-slate-500 mb-3 px-1">Team activity</div>
            <div className="flex flex-wrap gap-2 px-1">
              {members.slice(0, 8).map(member => {
                const initials = (member.name || member.email || "?").substring(0,2).toUpperCase();
                const isOnline = onlineMembers.includes(member.user_id);
                return (
                  <div key={member.id} className="relative group cursor-pointer" title={member.name}>
                    <div className="w-8 h-8 rounded-full bg-slate-800 border-2 border-slate-700 flex items-center justify-center text-xs font-bold text-slate-300 shadow-sm">
                      {initials}
                    </div>
                    {isOnline && (
                      <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-slate-900 rounded-full"></div>
                    )}
                  </div>
                );
              })}
              {members.length > 8 && (
                 <div className="w-8 h-8 rounded-full bg-slate-800 border-2 border-slate-700 border-dashed flex items-center justify-center text-xs font-bold text-slate-500">
                  +{members.length - 8}
                </div>
              )}
            </div>
          </div>

          <div className="pt-2 border-t border-slate-800/40">
            <LogoutButton className="w-full justify-start text-xs text-slate-400 hover:text-red-400 hover:bg-red-500/10 px-3 py-2 rounded-lg transition-colors gap-2" />
          </div>
        </div>
      </aside>

      {/* Main Area */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Responsive Mobile Header */}
        <header className="h-16 md:hidden flex items-center justify-between px-4 border-b border-slate-800/60 bg-slate-900">
          <div className="flex items-center min-w-0">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center mr-3 shrink-0">
               <span className="text-indigo-400 font-bold text-sm">CM</span>
            </div>
            <span className="font-semibold text-slate-200 truncate">{workspace.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/dashboard" className="text-xs text-slate-400 hover:text-slate-200 px-2.5 py-1.5 rounded bg-slate-800 border border-slate-700">
              Dashboard
            </Link>
            <LogoutButton size="sm" showText={false} variant="outline" className="border-slate-800 text-slate-400 hover:text-red-400" />
          </div>
        </header>

        {error && (
          <div className="mx-4 mt-3 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-amber-400 text-sm flex items-center gap-2 shrink-0">
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            {error}
          </div>
        )}

        {children}
      </main>
    </div>
    </SocketProvider>
  );
}
