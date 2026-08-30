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
  const addMessage = useChatStore(s => s.addMessage);

  useEffect(() => {
    if (typeof window === "undefined" || !workspaceId) return;
    
    const token = (session as any)?.user?.id || (session as any)?.accessToken || 'demo-guest-token';

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

    socket.on('workspace:member-online', ({ userId }) => setOnline(userId));
    socket.on('workspace:member-offline', ({ userId }) => setOffline(userId));
    socket.on('chat:message', (data) => addMessage(data.message));
    
    return () => {
      socket.disconnect();
    };
  }, [workspaceId, session, setOnline, setOffline, addMessage]);

  const sendMessage = (content: string) => {
    socketRef.current?.emit('chat:send', { workspaceId, content });
  };
  
  const sendTyping = () => {
    socketRef.current?.emit('chat:typing', { workspaceId });
  };

  return { socket: socketRef.current, sendMessage, sendTyping };
};
