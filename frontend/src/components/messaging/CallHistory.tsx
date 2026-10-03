"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Loader2, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMessaging } from "@/hooks/MessagingProvider";
import { useMessagingStore } from "@/store/messagingStore";
import { getCallHistory } from "@/lib/messagingApi";
import { conversationDisplay, describeCall, formatShortTime } from "@/lib/messagingUtils";
import { cn } from "@/lib/utils";
import type { CallHistoryItem } from "@/types/messaging";

export function CallHistory() {
  const { myUserId, startCall } = useMessaging();
  const conversations = useMessagingStore((s) => s.conversations);
  const inCall = useMessagingStore((s) => !!s.activeCall);
  const [calls, setCalls] = useState<CallHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCallHistory()
      .then((r) => {
        if (cancelled) return;
        setCalls(r.calls);
        setHasMore(r.calls.length >= 30);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load call history."));
    return () => { cancelled = true; };
  }, []);

  const loadMore = async () => {
    if (!calls?.length) return;
    setLoadingMore(true);
    try {
      const r = await getCallHistory(calls[calls.length - 1].created_at);
      setCalls([...calls, ...r.calls]);
      setHasMore(r.calls.length >= 30);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more.");
    } finally {
      setLoadingMore(false);
    }
  };

  const titleFor = (c: CallHistoryItem) => {
    const conv = conversations.find((x) => x.id === c.conversation_id);
    if (conv) return conversationDisplay(conv, myUserId).title;
    if (c.conversation_type === "group") return c.conversation_name || "Group";
    return c.participants.find((p) => p.user_id !== myUserId)?.name || "Unknown";
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-950">
      <header className="h-16 shrink-0 px-4 flex items-center gap-3 border-b border-slate-800/60 bg-slate-900/60">
        <Link href="/messages" aria-label="Back" className="md:hidden p-2 -ml-1 text-slate-400 hover:text-slate-50"><ArrowLeft className="w-5 h-5" /></Link>
        <h2 className="font-semibold text-slate-50">Call history</h2>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-6">
        <div className="max-w-2xl mx-auto">
          {error && (
            <div className="flex items-center gap-2 text-sm text-red-400 mb-4" role="alert"><AlertCircle className="w-4 h-4" />{error}</div>
          )}
          {!calls && !error && <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-indigo-500" /></div>}
          {calls?.length === 0 && <p className="text-center text-sm text-slate-500 py-10">No calls yet.</p>}
          <ul className="divide-y divide-slate-800/60">
            {calls?.map((c) => {
              const missed = c.status === "missed" && c.direction === "incoming";
              const Icon = missed ? PhoneMissed : c.direction === "outgoing" ? PhoneOutgoing : PhoneIncoming;
              return (
                <li key={c.id} className="flex items-center gap-3 py-3">
                  <div className={cn("w-9 h-9 rounded-full flex items-center justify-center shrink-0", missed ? "bg-red-500/10 text-red-400" : "bg-slate-800 text-slate-300")}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={cn("text-sm truncate", missed ? "text-red-300" : "text-slate-100")}>{titleFor(c)}</div>
                    <div className="text-xs text-slate-500 flex items-center gap-1.5">
                      {c.kind === "video" && <Video className="w-3 h-3" />}
                      {describeCall(c)} · {formatShortTime(c.created_at)}
                    </div>
                  </div>
                  <Button
                    size="sm" variant="outline" disabled={inCall}
                    onClick={() => startCall(c.conversation_id, c.kind)}
                    className="border-slate-700 text-slate-200 hover:bg-slate-800"
                    aria-label={`Call ${titleFor(c)} again`}
                  >
                    Call back
                  </Button>
                </li>
              );
            })}
          </ul>
          {hasMore && (
            <div className="flex justify-center pt-4">
              <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore} className="text-slate-400">
                {loadingMore && <Loader2 className="animate-spin mr-1" />} Load more
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
