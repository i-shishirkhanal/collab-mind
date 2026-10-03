import type { NextConfig } from "next";

// The browser talks to the backend (REST + websocket) and to LiveKit for calls; everything else
// is same-origin. Origins are derived from the same variables the app uses at runtime.
const origin = (value: string | undefined, fallback: string) => {
  try {
    return new URL(value || fallback).origin;
  } catch {
    return fallback;
  }
};

const api = origin(process.env.NEXT_PUBLIC_API_URL, "http://localhost:4000");
const ws = (process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:4000").replace(/\/+$/, "");
const livekit = process.env.NEXT_PUBLIC_LIVEKIT_URL || "wss://*.livekit.cloud";
const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; dev mode additionally needs eval for fast refresh.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Images from the app, data URIs and https avatars/attachments; blocks http exfiltration images.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${api} ${ws} ${livekit} https://*.livekit.cloud wss://*.livekit.cloud`,
  "media-src 'self' blob: https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
          ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
        ],
      },
    ];
  },
};

export default nextConfig;
