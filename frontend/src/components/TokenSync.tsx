"use client";

import { useEffect } from "react";

// Older builds copied the backend session token into localStorage under these keys.
// Nothing reads them any more (lib/authToken.ts takes the token from the NextAuth
// session), and a bearer token in localStorage is readable by any injected script,
// so remove leftovers from browsers that used an older build.
const LEGACY_TOKEN_KEYS = ["supabase_auth_token", "demo-guest-token"];

export function TokenSync() {
  useEffect(() => {
    try {
      LEGACY_TOKEN_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch {
      /* storage unavailable (private mode / blocked): nothing to clean */
    }
  }, []);

  return null;
}
