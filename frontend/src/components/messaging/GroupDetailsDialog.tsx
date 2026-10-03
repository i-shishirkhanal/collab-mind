"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Crown, Loader2, LogOut, Pencil, UserMinus, UserPlus, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMessaging } from "@/hooks/MessagingProvider";
import { useMessagingStore } from "@/store/messagingStore";
import * as api from "@/lib/messagingApi";
import { Initials } from "./Initials";
import { UserPicker } from "./UserPicker";
import type { ChatUser, Conversation } from "@/types/messaging";

export function GroupDetailsDialog({
  conversation, open, onOpenChange,
}: { conversation: Conversation; open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const { myUserId } = useMessaging();
  const upsert = useMessagingStore((s) => s.upsertConversation);
  const online = useMessagingStore((s) => s.onlineUserIds);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(conversation.name || "");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const myRole = conversation.members.find((m) => m.user_id === myUserId)?.role;
  const isAdmin = myRole === "admin";

  const run = async (key: string, fn: () => Promise<Conversation | void>) => {
    setBusyId(key);
    setError(null);
    try {
      const updated = await fn();
      if (updated) upsert(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  };

  const saveName = () =>
    run("name", async () => {
      const updated = await api.updateGroup(conversation.id, { name: name.trim() });
      setEditing(false);
      return updated;
    });

  const leave = () => {
    if (!window.confirm("Leave this group?")) return;
    run("leave", async () => {
      await api.removeGroupMember(conversation.id, myUserId!);
      useMessagingStore.getState().removeConversation(conversation.id);
      onOpenChange(false);
      router.push("/messages");
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px] bg-slate-900 border-slate-800 text-slate-50 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          {editing ? (
            <div className="flex items-center gap-2 pr-8">
              <Input
                value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus aria-label="Group name"
                className="bg-slate-800 border-slate-700 text-slate-50"
                onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) saveName(); }}
              />
              <Button size="icon" disabled={!name.trim() || busyId === "name"} onClick={saveName} aria-label="Save name">
                {busyId === "name" ? <Loader2 className="animate-spin" /> : <Check />}
              </Button>
              <Button size="icon" variant="ghost" onClick={() => { setEditing(false); setName(conversation.name || ""); }} aria-label="Cancel"><X /></Button>
            </div>
          ) : (
            <DialogTitle className="text-xl flex items-center gap-2 pr-8">
              <span className="truncate">{conversation.name}</span>
              {isAdmin && (
                <button type="button" onClick={() => setEditing(true)} aria-label="Rename group" className="p-1 text-slate-400 hover:text-slate-50"><Pencil className="w-4 h-4" /></button>
              )}
            </DialogTitle>
          )}
          <DialogDescription className="text-slate-400">
            {conversation.members.length} member{conversation.members.length === 1 ? "" : "s"}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-red-400" role="alert">{error}</p>}

        <ul className="divide-y divide-slate-800/70 rounded-lg border border-slate-800">
          {conversation.members.map((m) => {
            const self = m.user_id === myUserId;
            return (
              <li key={m.user_id} className="flex items-center gap-3 px-3 py-2">
                <Initials name={m.name} src={m.avatar_url} className="w-9 h-9" online={online.includes(m.user_id) || self} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-100 truncate">{m.name}{self ? " (you)" : ""}</div>
                  <div className="text-xs text-slate-500 truncate flex items-center gap-1">
                    {m.role === "admin" && <Crown className="w-3 h-3 text-amber-400" />}
                    {m.role === "admin" ? "Admin" : m.email}
                  </div>
                </div>
                {isAdmin && !self && (
                  <div className="flex items-center">
                    <Button
                      size="xs" variant="ghost" className="text-slate-400"
                      disabled={busyId === m.user_id}
                      onClick={() => run(m.user_id, () => api.setGroupMemberRole(conversation.id, m.user_id, m.role === "admin" ? "member" : "admin"))}
                    >
                      {m.role === "admin" ? "Remove admin" : "Make admin"}
                    </Button>
                    <Button
                      size="icon-sm" variant="ghost" aria-label={`Remove ${m.name}`} className="text-slate-400 hover:text-red-400"
                      disabled={busyId === m.user_id}
                      onClick={() => {
                        if (!window.confirm(`Remove ${m.name} from the group?`)) return;
                        run(m.user_id, async () => { await api.removeGroupMember(conversation.id, m.user_id); return api.getConversation(conversation.id); });
                      }}
                    >
                      <UserMinus />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {isAdmin && (
          adding ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm text-slate-300">
                Add people
                <Button size="xs" variant="ghost" onClick={() => setAdding(false)}>Done</Button>
              </div>
              <UserPicker
                excludeIds={conversation.members.map((m) => m.user_id)}
                onPick={(u: ChatUser) => run(u.id, () => api.addGroupMembers(conversation.id, [u.id]))}
              />
            </div>
          ) : (
            <Button variant="outline" onClick={() => setAdding(true)} className="border-slate-700 text-slate-200 hover:bg-slate-800">
              <UserPlus className="mr-1.5" /> Add members
            </Button>
          )
        )}

        <Button variant="destructive" onClick={leave} disabled={busyId === "leave"}>
          {busyId === "leave" ? <Loader2 className="animate-spin mr-1.5" /> : <LogOut className="mr-1.5" />}
          Leave group
        </Button>
      </DialogContent>
    </Dialog>
  );
}
