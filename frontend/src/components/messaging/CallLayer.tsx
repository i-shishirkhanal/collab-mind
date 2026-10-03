"use client";

import { useEffect, useState } from "react";
import { Phone, PhoneOff, Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMessaging } from "@/hooks/MessagingProvider";
import { useMessagingStore } from "@/store/messagingStore";
import { Initials } from "./Initials";
import { CallRoom } from "./CallRoom";

const RING_SECONDS = 45;

function IncomingCall() {
  const call = useMessagingStore((s) => s.incomingCall)!;
  const { acceptIncomingCall, declineIncomingCall } = useMessaging();
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(RING_SECONDS);

  useEffect(() => {
    const t = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  // Server marks the invite missed after the same timeout; mirror it locally.
  useEffect(() => {
    if (left === 0) useMessagingStore.getState().setIncomingCall(null);
  }, [left]);

  const isGroup = call.conversation_type === "group";
  const title = isGroup ? call.conversation_name || "Group call" : call.started_by_name || "Incoming call";

  return (
    <div
      role="alertdialog"
      aria-label={`Incoming ${call.kind} call from ${title}`}
      className="fixed z-[70] top-4 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-sm bg-slate-900 border border-indigo-500/40 rounded-2xl shadow-2xl shadow-indigo-500/10 p-4 animate-in fade-in slide-in-from-top-4"
    >
      <div className="flex items-center gap-3">
        <Initials name={title} className="w-12 h-12" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-50 truncate">{title}</div>
          <div className="text-xs text-slate-400 flex items-center gap-1">
            {call.kind === "video" ? <Video className="w-3 h-3" /> : <Phone className="w-3 h-3" />}
            {isGroup ? `${call.started_by_name || "Someone"} started a ` : "Incoming "}
            {call.kind} call
          </div>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <Button
          variant="outline" className="flex-1 h-10 border-red-500/40 text-red-400 hover:bg-red-500/10"
          disabled={busy} onClick={async () => { setBusy(true); await declineIncomingCall(); }}
        >
          <PhoneOff className="mr-1.5" /> Decline
        </Button>
        <Button
          className="flex-1 h-10 bg-green-600 hover:bg-green-700 text-white"
          disabled={busy} onClick={async () => { setBusy(true); await acceptIncomingCall(); setBusy(false); }}
        >
          <Phone className="mr-1.5" /> Accept
        </Button>
      </div>
    </div>
  );
}

/**
 * Mounted once at the app root so invitations and in-progress calls survive
 * navigation between pages.
 */
export function CallLayer() {
  const incoming = useMessagingStore((s) => s.incomingCall);
  const active = useMessagingStore((s) => s.activeCall);
  const conversations = useMessagingStore((s) => s.conversations);
  const { myUserId, leaveActiveCall, endActiveCall, callError, clearCallError } = useMessaging();

  useEffect(() => {
    if (!callError) return;
    const t = setTimeout(clearCallError, 6000);
    return () => clearTimeout(t);
  }, [callError, clearCallError]);

  const activeTitle = (() => {
    if (!active) return "";
    const conv = conversations.find((c) => c.id === active.call.conversation_id);
    if (conv?.type === "group") return conv.name || "Group call";
    const other = conv?.members.find((m) => m.user_id !== myUserId);
    return other?.name || active.call.conversation_name || active.call.started_by_name || "Call";
  })();

  return (
    <>
      {incoming && !active && <IncomingCall key={incoming.id} />}
      {active && (
        <CallRoom
          key={active.call.id}
          call={active.call}
          token={active.token}
          url={active.url}
          title={activeTitle}
          isHost={active.call.started_by === myUserId}
          onLeave={leaveActiveCall}
          onEndForAll={endActiveCall}
        />
      )}
      {callError && (
        <div className="fixed z-[80] bottom-4 left-1/2 -translate-x-1/2 max-w-sm w-[calc(100%-2rem)] bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-xl px-4 py-3 flex items-start gap-2">
          <span className="flex-1">{callError}</span>
          <button onClick={clearCallError} aria-label="Dismiss" className="text-red-300 hover:text-slate-50"><X className="w-4 h-4" /></button>
        </div>
      )}
    </>
  );
}
