"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, X } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createDirectConversation, createGroupConversation } from "@/lib/messagingApi";
import { useMessagingStore } from "@/store/messagingStore";
import { UserPicker } from "./UserPicker";
import type { ChatUser } from "@/types/messaging";

export function NewConversationDialog() {
  const router = useRouter();
  const upsert = useMessagingStore((s) => s.upsertConversation);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"direct" | "group">("direct");
  const [groupName, setGroupName] = useState("");
  const [picked, setPicked] = useState<ChatUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setMode("direct"); setGroupName(""); setPicked([]); setError(null); setBusy(false); };

  const finish = (conv: Awaited<ReturnType<typeof createDirectConversation>>) => {
    upsert(conv);
    setOpen(false);
    reset();
    router.push(`/messages/${conv.id}`);
  };

  const startDirect = async (user: ChatUser) => {
    setBusy(true);
    setError(null);
    try {
      finish(await createDirectConversation(user.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the conversation.");
      setBusy(false);
    }
  };

  const createGroup = async () => {
    setBusy(true);
    setError(null);
    try {
      finish(await createGroupConversation(groupName.trim(), picked.map((u) => u.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the group.");
      setBusy(false);
    }
  };

  const togglePick = (u: ChatUser) =>
    setPicked((cur) => (cur.some((p) => p.id === u.id) ? cur.filter((p) => p.id !== u.id) : [...cur, u]));

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger render={<Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white" aria-label="New conversation" />}>
        <Plus className="mr-1" /> New
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px] bg-slate-900 border-slate-800 text-slate-50">
        <DialogHeader>
          <DialogTitle className="text-xl">New conversation</DialogTitle>
          <DialogDescription className="text-slate-400">
            Message a teammate, or start a group.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-slate-800" role="tablist">
          {(["direct", "group"] as const).map((m) => (
            <button
              key={m} role="tab" aria-selected={mode === m} type="button" onClick={() => setMode(m)}
              className={`py-1.5 rounded-md text-sm font-medium transition-colors ${mode === m ? "bg-slate-700 text-slate-50" : "text-slate-400 hover:text-slate-200"}`}
            >
              {m === "direct" ? "Direct message" : "Group"}
            </button>
          ))}
        </div>

        {mode === "group" && (
          <div className="space-y-2">
            <Label htmlFor="group-name" className="text-slate-300">Group name</Label>
            <Input
              id="group-name" value={groupName} maxLength={120}
              onChange={(e) => setGroupName(e.target.value)} placeholder="e.g. Project Atlas"
              className="bg-slate-800 border-slate-700 text-slate-50 placeholder:text-slate-500"
            />
            {picked.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {picked.map((u) => (
                  <span key={u.id} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full bg-indigo-500/15 text-indigo-200 text-xs">
                    {u.name}
                    <button type="button" aria-label={`Remove ${u.name}`} onClick={() => togglePick(u)} className="p-0.5 rounded-full hover:bg-indigo-500/30">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <UserPicker
          onPick={mode === "direct" ? startDirect : togglePick}
          selectedIds={picked.map((u) => u.id)}
        />

        {error && <p className="text-sm text-red-400" role="alert">{error}</p>}

        {mode === "group" && (
          <div className="flex justify-end">
            <Button
              onClick={createGroup}
              disabled={busy || !groupName.trim() || picked.length === 0}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create group{picked.length > 0 ? ` (${picked.length + 1})` : ""}
            </Button>
          </div>
        )}
        {mode === "direct" && busy && (
          <div className="flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-indigo-400" /></div>
        )}
      </DialogContent>
    </Dialog>
  );
}
