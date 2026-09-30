"use client";

import { createContext, useContext } from "react";
import { useSocket } from "./useSocket";

type SocketContextValue = ReturnType<typeof useSocket>;

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: React.ReactNode;
}) {
  const socketApi = useSocket(workspaceId);
  return <SocketContext.Provider value={socketApi}>{children}</SocketContext.Provider>;
}

export function useSocketContext() {
  const ctx = useContext(SocketContext);
  if (!ctx) {
    throw new Error("useSocketContext must be used within a SocketProvider");
  }
  return ctx;
}
