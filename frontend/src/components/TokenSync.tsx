"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";

const TOKEN_KEY = "supabase_auth_token";

/**
 * apiCall() and the socket hook read the session token from localStorage
 * rather than from next-auth's session object directly (they run outside
 * React in some cases). This keeps that key in sync with the real
 * next-auth session so requests carry the actual signed backend JWT
 * instead of silently falling back to the shared demo identity.
 */
export function TokenSync() {
  const { data: session, status } = useSession();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = (session as any)?.accessToken;
    if (status === "authenticated" && token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else if (status === "unauthenticated") {
      localStorage.removeItem(TOKEN_KEY);
    }
  }, [session, status]);

  return null;
}
