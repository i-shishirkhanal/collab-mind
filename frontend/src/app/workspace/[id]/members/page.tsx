"use client";

import { use, useState } from "react";
import { useSession } from "next-auth/react";
import { useWorkspaceStore, usePresenceStore } from "@/lib/store";
import { inviteMember, updateMemberRole, removeMember, getWorkspaceMembers } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, UserPlus, X, Check, AlertCircle } from "lucide-react";

const ROLES = ["member", "admin", "owner"] as const;

export default function MembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session } = useSession();
  const members = useWorkspaceStore(s => s.members);
  const setMembers = useWorkspaceStore(s => s.setMembers);
  const onlineMembers = usePresenceStore(s => s.onlineMembers);

  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<typeof ROLES[number]>("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const currentUserId = (session as any)?.user?.id;
  const self = members.find(m => m.user_id === currentUserId);
  const isOwner = self?.role === "owner";

  const handleInvite = async () => {
    if (!email.trim()) return;
    setInviting(true);
    setInviteError(null);
    setInviteSuccess(null);
    try {
      await inviteMember(id, email.trim(), inviteRole);
      // The invite endpoint only returns the raw membership row (no
      // name/email), so refetch the fully-hydrated list instead of
      // splicing a partial object into state.
      const refreshed = await getWorkspaceMembers(id);
      setMembers(Array.isArray(refreshed) ? refreshed : (refreshed?.members ?? []));
      setInviteSuccess(`${email.trim()} added to the workspace.`);
      setEmail("");
    } catch (err: any) {
      setInviteError(err.message || "Failed to invite member");
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (userId: string, role: string) => {
    setBusyUserId(userId);
    setRowError(null);
    try {
      await updateMemberRole(id, userId, role);
      setMembers(members.map(m => (m.user_id === userId ? { ...m, role: role as any } : m)));
    } catch (err: any) {
      setRowError(err.message || "Failed to update role");
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRemove = async (userId: string) => {
    setBusyUserId(userId);
    setRowError(null);
    try {
      await removeMember(id, userId);
      setMembers(members.filter(m => m.user_id !== userId));
    } catch (err: any) {
      setRowError(err.message || "Failed to remove member");
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-slate-950 custom-scrollbar p-8">
      <div className="max-w-4xl mx-auto space-y-8">

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-serif font-semibold text-slate-50 tracking-tight">Team members</h1>
            <p className="text-sm text-slate-400 mt-1">Manage access to this collaborative workspace.</p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            {onlineMembers.length} online now
          </div>
        </div>

        {isOwner && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-3">
            <label className="text-sm font-medium text-slate-300">Invite a new member</label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleInvite()}
                className="bg-slate-800 border-slate-700 text-slate-50 flex-1"
                disabled={inviting}
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as typeof ROLES[number])}
                className="bg-slate-800 border border-slate-700 rounded-md text-slate-200 px-3 text-sm focus:ring-1 focus:ring-indigo-500 outline-none w-32 capitalize"
                disabled={inviting}
              >
                {ROLES.map(r => <option key={r} value={r} className="capitalize">{r}</option>)}
              </select>
              <Button
                onClick={handleInvite}
                disabled={inviting || !email.trim()}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium gap-2"
              >
                {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                Send Invite
              </Button>
            </div>
            {inviteError && (
              <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" />{inviteError}</p>
            )}
            {inviteSuccess && (
              <p className="text-xs text-green-400 flex items-center gap-1.5"><Check className="w-3.5 h-3.5" />{inviteSuccess}</p>
            )}
            <p className="text-xs text-slate-500">The invited person must already have a CollabMind account with this email.</p>
          </div>
        )}

        {rowError && (
          <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" />{rowError}</p>
        )}

        <div className="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden shadow-sm">
          <ul className="divide-y divide-slate-800/60">
            {members.length === 0 && (
              <li className="p-8 text-center text-sm text-slate-500">No members yet.</li>
            )}
            {members.map(member => {
              const isOnline = onlineMembers.includes(member.user_id);
              const isSelf = member.user_id === currentUserId;
              const isBusy = busyUserId === member.user_id;
              return (
                <li key={member.id} className="p-4 flex items-center justify-between hover:bg-slate-800/30 transition-colors">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="relative shrink-0">
                      <div className="w-10 h-10 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 font-bold flex items-center justify-center uppercase shadow-sm">
                        {(member.name || member.email || "?").substring(0, 2)}
                      </div>
                      {isOnline && (
                         <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-slate-900 rounded-full shadow-sm"></div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <h4 className="font-semibold text-slate-200 truncate">
                        {member.name}{isSelf && <span className="text-slate-500 font-normal"> (you)</span>}
                      </h4>
                      <p className="text-xs text-slate-400 truncate">{member.email}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    {isOwner && !isSelf ? (
                      <select
                        value={member.role}
                        onChange={(e) => handleRoleChange(member.user_id, e.target.value)}
                        disabled={isBusy}
                        className="bg-slate-800 border border-slate-700 rounded-md text-slate-300 text-xs px-2 py-1.5 outline-none capitalize disabled:opacity-50"
                      >
                        {ROLES.map(r => <option key={r} value={r} className="capitalize">{r}</option>)}
                      </select>
                    ) : (
                      <Badge variant="outline" className="capitalize text-slate-300 border-slate-700 bg-slate-800/50">
                        {member.role}
                      </Badge>
                    )}

                    {isOwner && !isSelf && (
                      <button
                        onClick={() => handleRemove(member.user_id)}
                        disabled={isBusy}
                        title="Remove member"
                        className="w-7 h-7 rounded-md flex items-center justify-center text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      >
                        {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

      </div>
    </div>
  );
}
