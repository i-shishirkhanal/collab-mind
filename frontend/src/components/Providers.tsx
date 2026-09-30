"use client";
import { SessionProvider } from "next-auth/react";
import { TokenSync } from "./TokenSync";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <TokenSync />
      {children}
    </SessionProvider>
  );
}
