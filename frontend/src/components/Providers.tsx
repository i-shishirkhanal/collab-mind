"use client";
import { SessionProvider } from "next-auth/react";
import { TokenSync } from "./TokenSync";
import { MessagingProvider } from "@/hooks/MessagingProvider";
import { CallLayer } from "./messaging/CallLayer";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <TokenSync />
      {/* Chat/call sockets + incoming-call UI; connects only once the user is signed in */}
      <MessagingProvider>
        {children}
        <CallLayer />
      </MessagingProvider>
    </SessionProvider>
  );
}
