import { getSession, signOut } from "next-auth/react";

/**
 * The one place the browser gets the backend access token: the authenticated
 * NextAuth session. There is no localStorage token and no guest/demo fallback;
 * with no valid session this returns null and callers must treat that as
 * "signed out".
 */
let cached: { token: string | null; at: number } | null = null;
const TTL_MS = 15_000;

export async function getAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.token;
  const session = (await getSession()) as { accessToken?: string; error?: string } | null;
  const token = session && !session.error ? session.accessToken ?? null : null;
  cached = { token, at: Date.now() };
  return token;
}

export function clearAccessTokenCache() {
  cached = null;
}

/** Called when the API answers 401: the session is gone or revoked. */
export function handleUnauthorized() {
  clearAccessTokenCache();
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/auth")) {
    void signOut({ callbackUrl: "/auth/signin" });
  }
}
