"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Info, Loader2, Phone, PhoneCall, Users, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMessaging } from "@/hooks/MessagingProvider";
import { useMessagingStore } from "@/store/messagingStore";
import * as api from "@/lib/messagingApi";
import { conversationDisplay, readersOf } from "@/lib/messagingUtils";
import { Initials } from "./Initials";
import { MessageBubble } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import { GroupDetailsDialog } from "./GroupDetailsDialog";
import type { DirectMessage } from "@/types/messaging";

const EMPTY: DirectMessage[] = [];
const NEAR_BOTTOM_PX = 140;

const errText = (err: unknown) => {
  const m = err instanceof Error ? err.message : "";
  if (m === "CONNECTION_FAILED") return "Could not reach the server.";
  return m || "Something went wrong.";
};

/** Render with `key={conversationId}` so local state resets when switching threads. */
export function MessageThread({ conversationId }: { conversationId: string }) {
  const { myUserId, setOpenConversation, sendTyping, startCall, joinCallById } = useMessaging();
  const conv = useMessagingStore((s) => s.conversations.find((c) => c.id === conversationId));
  const convsLoaded = useMessagingStore((s) => s.conversationsLoaded);
  const messages = useMessagingStore((s) => s.messages[conversationId]) ?? EMPTY;
  const hasMore = useMessagingStore((s) => s.hasMore[conversationId]) ?? false;
  const reads = useMessagingStore((s) => s.reads[conversationId]);
  const typing = useMessagingStore((s) => s.typing[conversationId]);
  const online = useMessagingStore((s) => s.onlineUserIds);
  const liveCall = useMessagingStore((s) => s.liveCalls[conversationId]);
  const inCall = useMessagingStore((s) => !!s.activeCall);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [replyTo, setReplyTo] = useState<DirectMessage | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef<number | null>(null);

  const markRead = useCallback(() => {
    useMessagingStore.getState().clearUnread(conversationId);
    api.markConversationRead(conversationId).catch(() => {});
  }, [conversationId]);

  // Initial history + read pointer + "which thread is on screen"
  useEffect(() => {
    let cancelled = false;
    setOpenConversation(conversationId);
    api.getMessages(conversationId)
      .then((r) => {
        if (cancelled) return;
        useMessagingStore.getState().setMessages(conversationId, r.messages, r.has_more, r.read_state);
        markRead();
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof Error && /not found/i.test(err.message)) setNotFound(true);
        else setLoadError(errText(err));
      })
      .finally(() => !cancelled && setLoading(false));
    // Seed the "call in progress" banner (live updates arrive over the socket afterwards).
    api.getConversationCalls(conversationId)
      .then(({ active }) => {
        if (!cancelled && active) useMessagingStore.getState().trackCall(active);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      setOpenConversation(null);
    };
  }, [conversationId, markRead, setOpenConversation]);

  // Deep links: fetch the conversation if the sidebar list doesn't have it yet.
  useEffect(() => {
    if (!convsLoaded || conv) return;
    let cancelled = false;
    api.getConversation(conversationId)
      .then((c) => !cancelled && useMessagingStore.getState().upsertConversation(c))
      .catch(() => !cancelled && setNotFound(true));
    return () => { cancelled = true; };
  }, [convsLoaded, conv, conversationId]);

  // Mark read again when the tab becomes visible with unread messages.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") markRead();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [markRead]);

  // Keep pinned to the bottom for new messages; preserve position when older ones are prepended.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevHeight.current !== null) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
      return;
    }
    const last = messages[messages.length - 1];
    if (stickToBottom.current || last?.sender_id === myUserId) el.scrollTop = el.scrollHeight;
  }, [messages, myUserId, loading]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  const loadOlder = async () => {
    const oldest = messages[0];
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const r = await api.getMessages(conversationId, oldest.created_at);
      prevHeight.current = scrollRef.current?.scrollHeight ?? null;
      useMessagingStore.getState().prependMessages(conversationId, r.messages, r.has_more);
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  const me = conv?.members.find((m) => m.user_id === myUserId);

  const optimistic = (partial: Partial<DirectMessage>): DirectMessage => ({
    id: `temp-${crypto.randomUUID()}`,
    conversation_id: conversationId,
    sender_id: myUserId ?? null,
    sender_name: me?.name ?? null,
    kind: "text",
    body: "",
    attachment: null,
    reply_to: replyTo ? { id: replyTo.id, sender_name: replyTo.sender_name, body: replyTo.body.slice(0, 140) } : null,
    created_at: new Date().toISOString(),
    deleted: false,
    pending: true,
    ...partial,
  });

  const sendText = async (body: string, replyId = replyTo?.id) => {
    const temp = optimistic({ body });
    const store = useMessagingStore.getState();
    store.addMessage(temp);
    setReplyTo(null);
    stickToBottom.current = true;
    try {
      const saved = await api.sendDirectMessage(conversationId, body, replyId);
      useMessagingStore.getState().replaceMessage(conversationId, temp.id, saved);
    } catch {
      useMessagingStore.getState().markMessageFailed(conversationId, temp.id);
    }
  };

  const sendFile = async (file: File, caption: string) => {
    const saved = await api.sendAttachment(conversationId, file, caption);
    useMessagingStore.getState().addMessage(saved);
    setReplyTo(null);
    stickToBottom.current = true;
  };

  const retry = (m: DirectMessage) => {
    useMessagingStore.getState().removeMessage(conversationId, m.id);
    sendText(m.body, m.reply_to?.id);
  };

  const remove = async (m: DirectMessage) => {
    if (!window.confirm("Delete this message for everyone?")) return;
    try {
      await api.deleteDirectMessage(conversationId, m.id);
      useMessagingStore.getState().markDeleted(conversationId, m.id);
    } catch (err) {
      setActionError(errText(err));
    }
  };

  if (notFound) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400 p-6 text-center">
        <AlertCircle className="w-8 h-8 text-slate-600" />
        <p>This conversation doesn&apos;t exist or you&apos;re no longer a member.</p>
        <Link href="/messages" className="text-indigo-400 hover:underline text-sm">Back to messages</Link>
      </div>
    );
  }

  if (!conv) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-indigo-500" /></div>;
  }

  const d = conversationDisplay(conv, myUserId);
  const isGroup = conv.type === "group";
  const memberIds = conv.members.map((m) => m.user_id);
  const typingNames = Object.entries(typing || {}).filter(([id]) => id !== myUserId).map(([, name]) => name);
  const otherOnline = d.otherUserId ? online.includes(d.otherUserId) : false;
  const subtitle = isGroup
    ? `${conv.members.length} members${online.some((id) => id !== myUserId && memberIds.includes(id)) ? " · some online" : ""}`
    : otherOnline ? "Online" : "Offline";
  const callsBlocked = inCall || !!liveCall;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-950">
      <header className="h-16 shrink-0 px-3 sm:px-4 flex items-center gap-3 border-b border-slate-800/60 bg-slate-900/60">
        <Link href="/messages" aria-label="Back to conversations" className="md:hidden p-2 -ml-1 text-slate-400 hover:text-slate-50">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        {isGroup ? (
          <div className="w-10 h-10 rounded-full bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
            <Users className="w-4 h-4 text-indigo-300" />
          </div>
        ) : (
          <Initials name={d.title} src={d.avatar} online={otherOnline} />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-50 truncate">{d.title}</div>
          <div className="text-xs text-slate-400 truncate">
            {typingNames.length > 0
              ? <span className="text-indigo-300">{typingNames.join(", ")} {typingNames.length > 1 ? "are" : "is"} typing…</span>
              : subtitle}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-lg" aria-label="Start voice call" title="Voice call" disabled={callsBlocked} onClick={() => startCall(conversationId, "audio")} className="text-slate-300 hover:text-slate-50"><Phone /></Button>
          <Button variant="ghost" size="icon-lg" aria-label="Start video call" title="Video call" disabled={callsBlocked} onClick={() => startCall(conversationId, "video")} className="text-slate-300 hover:text-slate-50"><Video /></Button>
          {isGroup && (
            <Button variant="ghost" size="icon-lg" aria-label="Group details" title="Group details" onClick={() => setDetailsOpen(true)} className="text-slate-300 hover:text-slate-50"><Info /></Button>
          )}
        </div>
      </header>

      {liveCall && !inCall && (
        <div className="shrink-0 px-4 py-2 bg-green-500/10 border-b border-green-500/20 flex items-center gap-3 text-sm text-green-300">
          <PhoneCall className="w-4 h-4 shrink-0" />
          <span className="flex-1 min-w-0 truncate">
            {liveCall.kind === "video" ? "Video" : "Voice"} call in progress
            {liveCall.started_by_name ? ` · started by ${liveCall.started_by_name}` : ""}
          </span>
          <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={() => joinCallById(liveCall.id)}>Join</Button>
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 py-4" aria-live="polite">
        {loading ? (
          <div className="h-full flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-indigo-500" /></div>
        ) : loadError ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center text-sm text-red-400">
            <AlertCircle className="w-6 h-6" />{loadError}
          </div>
        ) : (
          <div className="max-w-3xl mx-auto">
            {hasMore && (
              <div className="flex justify-center mb-3">
                <Button variant="ghost" size="sm" onClick={loadOlder} disabled={loadingOlder} className="text-slate-400">
                  {loadingOlder && <Loader2 className="animate-spin mr-1" />} Load earlier messages
                </Button>
              </div>
            )}
            {messages.length === 0 && (
              <p className="text-center text-sm text-slate-500 py-10">No messages yet. Say hello 👋</p>
            )}
            {messages.map((m, i) => {
              const mine = m.sender_id === myUserId;
              const readers = mine ? readersOf(m, reads, memberIds) : [];
              const prev = messages[i - 1];
              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  mine={mine}
                  showSender={isGroup && (!prev || prev.sender_id !== m.sender_id || prev.kind === "system")}
                  receipt={mine
                    ? readers.length > 0
                      ? { state: "read", label: isGroup ? `${readers.length}` : undefined }
                      : { state: "sent" }
                    : undefined}
                  onReply={setReplyTo}
                  onDelete={remove}
                  onRetry={retry}
                />
              );
            })}
          </div>
        )}
      </div>

      {actionError && (
        <div className="mx-4 mb-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs flex justify-between" role="alert">
          {actionError}
          <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <MessageComposer
        disabled={loading || !!loadError}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSendText={(t) => sendText(t)}
        onSendFile={sendFile}
        onTyping={(isTyping) => sendTyping(conversationId, isTyping)}
      />

      {isGroup && <GroupDetailsDialog conversation={conv} open={detailsOpen} onOpenChange={setDetailsOpen} />}
    </div>
  );
}
