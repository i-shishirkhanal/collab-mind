"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { useSession } from "next-auth/react";
import { useMessagingStore } from "@/store/messagingStore";
import * as api from "@/lib/messagingApi";
import type { Call, CallKind, DirectMessage } from "@/types/messaging";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:4000";
const TYPING_EXPIRY_MS = 5000;

interface MessagingContextValue {
  myUserId: string | undefined;
  connected: boolean;
  /** Tell the provider which thread is on screen so it can auto-mark messages read. */
  setOpenConversation: (id: string | null) => void;
  sendTyping: (conversationId: string, isTyping: boolean) => void;
  refreshConversations: () => Promise<void>;
  startCall: (conversationId: string, kind: CallKind) => Promise<void>;
  acceptIncomingCall: () => Promise<void>;
  declineIncomingCall: () => Promise<void>;
  /** Join a call that is already in progress (e.g. from the thread banner). */
  joinCallById: (callId: string) => Promise<void>;
  leaveActiveCall: () => Promise<void>;
  endActiveCall: () => Promise<void>;
  callError: string | null;
  clearCallError: () => void;
}

const MessagingContext = createContext<MessagingContextValue | null>(null);

export function useMessaging() {
  const ctx = useContext(MessagingContext);
  if (!ctx) throw new Error("useMessaging must be used within a MessagingProvider");
  return ctx;
}

const errorMessage = (err: unknown, fallback: string) => {
  const m = err instanceof Error ? err.message : "";
  if (m === "CONNECTION_FAILED") return "Could not reach the server.";
  if (m === "UNAUTHORIZED") return "Your session has expired. Please sign in again.";
  return m || fallback;
};

export function MessagingProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const myUserId = (session as { user?: { id?: string } } | null)?.user?.id;
  const accessToken = (session as { accessToken?: string } | null)?.accessToken;

  const socketRef = useRef<Socket | null>(null);
  const openConversationRef = useRef<string | null>(null);
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [connected, setConnected] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);

  const store = useMessagingStore;

  const refreshConversations = useCallback(async () => {
    try {
      const { conversations } = await api.listConversations();
      store.getState().setConversations(conversations);
    } catch (err) {
      console.warn("Failed to load conversations:", errorMessage(err, ""));
      store.setState({ conversationsLoaded: true });
    }
  }, [store]);

  const refreshOne = useCallback(async (conversationId: string) => {
    try {
      store.getState().upsertConversation(await api.getConversation(conversationId));
    } catch {
      store.getState().removeConversation(conversationId); // 404 => no longer a member
    }
  }, [store]);

  // ── Socket lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "authenticated" || !accessToken || !myUserId) return;

    const socket = io(WS_URL, {
      path: "/socket.io",
      auth: { token: accessToken },
      query: { scope: "messaging" },
      reconnectionAttempts: Infinity,
      reconnectionDelayMax: 10_000,
    });
    socketRef.current = socket;
    const timers = typingTimers.current;

    const syncOnConnect = () => {
      setConnected(true);
      refreshConversations();
      socket.emit("presence:query", (res: { onlineUserIds?: string[] }) => {
        store.getState().setOnline(res?.onlineUserIds || []);
      });
      api.getPendingCalls()
        .then(({ calls }) => {
          const s = store.getState();
          if (calls[0] && !s.activeCall && !s.incomingCall) s.setIncomingCall(calls[0]);
        })
        .catch(() => {});
      // Re-fetch the open thread: messages sent while we were disconnected would otherwise be missing.
      const open = openConversationRef.current;
      if (open) {
        api.getMessages(open)
          .then((r) => store.getState().setMessages(open, r.messages, r.has_more, r.read_state))
          .catch(() => {});
      }
    };

    socket.on("connect", syncOnConnect);
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (err) => console.warn("Messaging socket:", err.message));

    socket.on("message:new", (m: DirectMessage) => {
      const s = store.getState();
      const isOpen = openConversationRef.current === m.conversation_id && document.visibilityState === "visible";
      s.addMessage(m);
      if (!s.conversations.some((c) => c.id === m.conversation_id)) refreshOne(m.conversation_id);
      s.bumpWithMessage(m, myUserId, isOpen);
      s.setTyping(m.conversation_id, m.sender_id || "", "", false);
      if (isOpen && m.sender_id !== myUserId) api.markConversationRead(m.conversation_id).catch(() => {});
    });
    socket.on("message:deleted", ({ conversationId, messageId }: { conversationId: string; messageId: string }) =>
      store.getState().markDeleted(conversationId, messageId));
    socket.on("message:read", ({ conversationId, userId, lastReadAt }: { conversationId: string; userId: string; lastReadAt: string }) =>
      store.getState().setRead(conversationId, userId, lastReadAt));

    socket.on("conv:typing", ({ conversationId, userId, name, isTyping }: { conversationId: string; userId: string; name: string; isTyping: boolean }) => {
      const key = `${conversationId}:${userId}`;
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      store.getState().setTyping(conversationId, userId, name, isTyping);
      if (isTyping) {
        // Safety net in case the "stopped typing" event is lost.
        timers.set(key, setTimeout(() => store.getState().setTyping(conversationId, userId, name, false), TYPING_EXPIRY_MS));
      }
    });

    socket.on("presence:update", ({ userId, online }: { userId: string; online: boolean }) =>
      store.getState().setPresence(userId, online));

    socket.on("conversation:added", ({ conversationId }: { conversationId: string }) => refreshOne(conversationId));
    socket.on("conversation:updated", ({ conversationId }: { conversationId: string }) => refreshOne(conversationId));
    socket.on("conversation:removed", ({ conversationId }: { conversationId: string }) =>
      store.getState().removeConversation(conversationId));

    // ── Calls ──
    socket.on("call:incoming", (call: Call) => {
      const s = store.getState();
      s.trackCall(call);
      if (call.started_by === myUserId) return;
      if (s.activeCall || s.incomingCall) return; // already busy; the invite times out server-side
      s.setIncomingCall(call);
    });
    socket.on("call:updated", (call: Call) => {
      const s = store.getState();
      s.trackCall(call);
      const me = call.participants.find((p) => p.user_id === myUserId);
      if (s.incomingCall?.id === call.id) {
        const stillRinging = call.status === "ringing" && me?.status === "invited";
        s.setIncomingCall(stillRinging ? call : null);
      }
      if (s.activeCall?.call.id === call.id) s.setActiveCall({ ...s.activeCall, call });
    });
    socket.on("call:ended", ({ callId }: { callId: string }) => {
      const s = store.getState();
      s.untrackCall(callId);
      if (s.incomingCall?.id === callId) s.setIncomingCall(null);
      if (s.activeCall?.call.id === callId) s.setActiveCall(null);
    });

    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [status, accessToken, myUserId, refreshConversations, refreshOne, store]);

  // Drop all cached chat data when the user signs out.
  useEffect(() => {
    if (status === "unauthenticated") store.getState().reset();
  }, [status, store]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const setOpenConversation = useCallback((id: string | null) => {
    openConversationRef.current = id;
  }, []);

  const sendTyping = useCallback((conversationId: string, isTyping: boolean) => {
    socketRef.current?.emit("conv:typing", { conversationId, isTyping });
  }, []);

  const withCallErrors = useCallback(async (fn: () => Promise<void>) => {
    setCallError(null);
    try {
      await fn();
    } catch (err) {
      setCallError(errorMessage(err, "Something went wrong with the call."));
    }
  }, []);

  const enterCall = useCallback((creds: { call: Call; token: string; url: string }) => {
    const s = store.getState();
    s.setIncomingCall(null);
    s.setActiveCall({ call: creds.call, token: creds.token, url: creds.url });
  }, [store]);

  const startCall = useCallback((conversationId: string, kind: CallKind) =>
    withCallErrors(async () => {
      if (store.getState().activeCall) throw new Error("You are already in a call.");
      enterCall(await api.startCall(conversationId, kind));
    }), [enterCall, store, withCallErrors]);

  const joinCallById = useCallback((callId: string) =>
    withCallErrors(async () => {
      if (store.getState().activeCall) throw new Error("You are already in a call.");
      enterCall(await api.joinCall(callId));
    }), [enterCall, store, withCallErrors]);

  const acceptIncomingCall = useCallback(async () => {
    const incoming = store.getState().incomingCall;
    if (incoming) await joinCallById(incoming.id);
  }, [joinCallById, store]);

  const declineIncomingCall = useCallback(async () => {
    const incoming = store.getState().incomingCall;
    if (!incoming) return;
    store.getState().setIncomingCall(null);
    await withCallErrors(async () => { await api.declineCall(incoming.id); });
  }, [store, withCallErrors]);

  const leaveActiveCall = useCallback(async () => {
    const active = store.getState().activeCall;
    if (!active) return;
    store.getState().setActiveCall(null);
    await api.leaveCall(active.call.id).catch(() => {}); // server also cleans up on socket drop
  }, [store]);

  const endActiveCall = useCallback(async () => {
    const active = store.getState().activeCall;
    if (!active) return;
    store.getState().setActiveCall(null);
    await withCallErrors(async () => { await api.endCall(active.call.id); });
  }, [store, withCallErrors]);

  const value = useMemo<MessagingContextValue>(() => ({
    myUserId, connected, setOpenConversation, sendTyping, refreshConversations,
    startCall, acceptIncomingCall, declineIncomingCall, joinCallById, leaveActiveCall, endActiveCall,
    callError, clearCallError: () => setCallError(null),
  }), [
    myUserId, connected, setOpenConversation, sendTyping, refreshConversations, startCall,
    acceptIncomingCall, declineIncomingCall, joinCallById, leaveActiveCall, endActiveCall, callError,
  ]);

  return <MessagingContext.Provider value={value}>{children}</MessagingContext.Provider>;
}
