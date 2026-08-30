"use client";

import { useEffect, useState, use } from "react";
import { MemberList } from "@/components/MemberList";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, MessageSquare, Users, Sparkles, PlusCircle } from "lucide-react";
import { getWorkspace, getMembers, getSources, getChatHistory } from "@/lib/api";
import Link from "next/link";

interface WorkspaceData {
  id: string;
  name: string;
  description?: string;
  created_at?: string;
}

interface MemberData {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar_url?: string;
}

interface SourceData {
  id: string;
  name: string;
  type: string;
  created_at: string;
}

interface ChatMessageData {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export default function WorkspaceOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = use(params);

  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [members, setMembers] = useState<MemberData[]>([]);
  const [sources, setSources] = useState<SourceData[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessageData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;

    let isMounted = true;

    async function loadWorkspaceOverview() {
      try {
        setLoading(true);
        const [wsData, membersData, sourcesData, chatData] = await Promise.allSettled([
          getWorkspace(workspaceId),
          getMembers(workspaceId),
          getSources(workspaceId),
          getChatHistory(workspaceId)
        ]);

        if (!isMounted) return;

        if (wsData.status === "fulfilled") setWorkspace(wsData.value);
        if (membersData.status === "fulfilled") setMembers(Array.isArray(membersData.value) ? membersData.value : []);
        if (sourcesData.status === "fulfilled") setSources(Array.isArray(sourcesData.value) ? sourcesData.value : []);
        if (chatData.status === "fulfilled") setChatMessages(Array.isArray(chatData.value) ? chatData.value : []);
      } catch (err) {
        console.error("Failed to load workspace overview data:", err);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadWorkspaceOverview();

    return () => {
      isMounted = false;
    };
  }, [workspaceId]);

  // Compute dynamic recent activities
  const recentActivities: Array<{ id: string; title: string; subtitle: string; time: string; color: string }> = [];

  sources.slice(0, 3).forEach((src) => {
    recentActivities.push({
      id: `src-${src.id}`,
      title: `Source uploaded: ${src.name}`,
      subtitle: `Type: ${src.type.toUpperCase()}`,
      time: src.created_at ? new Date(src.created_at).toLocaleString() : 'Recently',
      color: 'bg-indigo-500'
    });
  });

  chatMessages.slice(-3).reverse().forEach((msg) => {
    if (msg.role === 'user') {
      recentActivities.push({
        id: `chat-${msg.id}`,
        title: `Chat message sent`,
        subtitle: `"${msg.content.slice(0, 60)}${msg.content.length > 60 ? '...' : ''}"`,
        time: msg.created_at ? new Date(msg.created_at).toLocaleString() : 'Recently',
        color: 'bg-purple-500'
      });
    }
  });

  if (workspace?.created_at) {
    recentActivities.push({
      id: 'ws-created',
      title: `Workspace created`,
      subtitle: `Workspace "${workspace.name}" was set up`,
      time: new Date(workspace.created_at).toLocaleString(),
      color: 'bg-emerald-500'
    });
  }

  const mappedMembers = members.map((m) => ({
    id: m.id,
    name: m.name || m.email?.split('@')[0] || 'Team Member',
    email: m.email || '',
    role: m.role || 'member',
    isOnline: true
  }));

  return (
    <div className="p-8 h-full overflow-y-auto custom-scrollbar">
      <div className="max-w-5xl mx-auto space-y-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">
            {workspace ? workspace.name : "Workspace Overview"}
          </h1>
          <p className="text-slate-400 mt-2 text-sm">
            {workspace?.description || `Welcome to ${workspace?.name || "your"} workspace.`}
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="bg-slate-900/50 border-slate-800">
            <CardHeader className="pb-2">
              <CardDescription className="font-medium text-slate-400">Total Members</CardDescription>
              <CardTitle className="text-4xl text-white font-light flex items-center gap-3">
                {loading ? "-" : mappedMembers.length || 1} <Users className="w-6 h-6 text-indigo-500" />
              </CardTitle>
            </CardHeader>
          </Card>

          <Card className="bg-slate-900/50 border-slate-800">
            <CardHeader className="pb-2">
              <CardDescription className="font-medium text-slate-400">Indexed Sources</CardDescription>
              <CardTitle className="text-4xl text-white font-light flex items-center gap-3">
                {loading ? "-" : sources.length} <FileText className="w-6 h-6 text-emerald-500" />
              </CardTitle>
            </CardHeader>
          </Card>

          <Card className="bg-slate-900/50 border-slate-800">
            <CardHeader className="pb-2">
              <CardDescription className="font-medium text-slate-400">Chat Messages</CardDescription>
              <CardTitle className="text-4xl text-white font-light flex items-center gap-3">
                {loading ? "-" : chatMessages.length} <MessageSquare className="w-6 h-6 text-purple-500" />
              </CardTitle>
            </CardHeader>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <Card className="bg-slate-900 border-slate-800 shadow-xl h-full min-h-[400px]">
              <CardHeader>
                <CardTitle className="text-xl text-white">Recent Activity</CardTitle>
                <CardDescription className="text-slate-400">Latest actions in this workspace.</CardDescription>
              </CardHeader>
              <CardContent>
                {recentActivities.length > 0 ? (
                  <div className="space-y-6">
                    {recentActivities.slice(0, 5).map((act) => (
                      <div key={act.id} className="flex gap-4 items-start">
                        <div className={`w-2 h-2 mt-2 rounded-full ${act.color} shrink-0`} />
                        <div>
                          <p className="text-sm font-medium text-slate-200">{act.title}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{act.subtitle}</p>
                          <p className="text-xs text-slate-500 mt-1">{act.time}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center text-center p-8 space-y-4 text-slate-500">
                    <Sparkles className="w-10 h-10 text-indigo-400 opacity-60 animate-pulse" />
                    <div>
                      <p className="text-sm text-slate-300 font-medium">No activity in this workspace yet</p>
                      <p className="text-xs text-slate-500 mt-1">Upload a document or ask CollabMind AI a question to get started.</p>
                    </div>
                    <div className="flex gap-3 pt-2">
                      <Link href={`/workspace/${workspaceId}/sources`} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 text-xs font-medium transition-colors">
                        <PlusCircle className="w-3.5 h-3.5" /> Add Source
                      </Link>
                      <Link href={`/workspace/${workspaceId}/chat`} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 text-xs font-medium transition-colors">
                        <MessageSquare className="w-3.5 h-3.5" /> Open Chat
                      </Link>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-1">
            <Card className="bg-slate-900 border-slate-800 shadow-xl">
              <CardContent className="pt-6">
                <MemberList members={mappedMembers} />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
