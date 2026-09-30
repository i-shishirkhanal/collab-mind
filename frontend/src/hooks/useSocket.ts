"use client";

import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useSession } from 'next-auth/react';
import { usePresenceStore, useChatStore } from '@/lib/store';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:4000";

export const useSocket = (workspaceId?: string) => {
  const socketRef = useRef<Socket | null>(null);
  const { data: session } = useSession();
  
  const setOnline = usePresenceStore(s => s.setOnline);
  const setOffline = usePresenceStore(s => s.setOffline);
  const setTyping = usePresenceStore(s => s.setTyping);
  const clearTyping = usePresenceStore(s => s.clearTyping);
  const addMessage = useChatStore(s => s.addMessage);
  const typingTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (typeof window === "undefined" || !workspaceId) return;

    const userId = (session as any)?.user?.id;
    const token = (session as any)?.accessToken || userId || 'demo-guest-token';

    const socket = io(WS_URL, {
      path: '/socket.io',
      auth: { token },
      query: { workspaceId },
      reconnectionAttempts: 5,
      timeout: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Socket connected, requesting room join for workspace:', workspaceId);
      socket.emit('workspace:join_request', { workspaceId });
    });

    socket.on('connect_error', (err) => {
      console.warn('Socket connection status:', err.message);
    });

    socket.on('workspace:joined', () => {
      if (userId) setOnline(userId);
    });

    socket.on('presence:sync', ({ onlineUsers }: { onlineUsers: { userId: string }[] }) => {
      onlineUsers.forEach((u) => setOnline(u.userId));
    });
    socket.on('workspace:member-online', ({ userId: uid }) => setOnline(uid));
    socket.on('workspace:member-offline', ({ userId: uid }) => setOffline(uid));
    socket.on('chat:message', (data) => addMessage(data.message ?? data));

    socket.on('presence:typing', ({ userId: uid, name, isTyping }: { userId: string; name: string; isTyping: boolean }) => {
      if (uid === userId) return; // ignore our own echo, if any
      const timeouts = typingTimeouts.current;
      const existing = timeouts.get(uid);
      if (existing) clearTimeout(existing);

      if (isTyping) {
        setTyping({ userId: uid, name });
        timeouts.set(uid, setTimeout(() => {
          clearTyping(uid);
          timeouts.delete(uid);
        }, 4000));
      } else {
        clearTyping(uid);
        timeouts.delete(uid);
      }
    });

    const timeouts = typingTimeouts.current;
    return () => {
      timeouts.forEach((t) => clearTimeout(t));
      timeouts.clear();
      socket.disconnect();
    };
  }, [workspaceId, session, setOnline, setOffline, setTyping, clearTyping, addMessage]);

  const sendMessage = (content: string) => {
    socketRef.current?.emit('chat:message', { content });
  };

  const sendTyping = (isTyping: boolean) => {
    socketRef.current?.emit('presence:typing', { isTyping });
  };

  return { sendMessage, sendTyping };
};
