"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { verifyEmailToken } from "@/lib/authApi";

function VerifyEmail() {
  const token = useSearchParams().get("token");
  const [state, setState] = useState<"working" | "ok" | "failed">(token ? "working" : "failed");
  const [message, setMessage] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true; // the token is single-use; never submit it twice
    verifyEmailToken(token)
      .then((res) => {
        setMessage(res.message || "Email verified.");
        setState("ok");
      })
      .catch((err: Error) => {
        setMessage(err.message);
        setState("failed");
      });
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-center text-slate-200">
      <div className="w-full max-w-[420px] space-y-4 rounded-2xl border border-slate-800 bg-slate-900/90 p-8">
        <h1 className="font-serif text-2xl text-slate-50">
          {state === "working" ? "Verifying…" : state === "ok" ? "Email verified" : "Link not valid"}
        </h1>
        <p className="text-sm text-slate-400">
          {state === "ok"
            ? message
            : state === "failed"
              ? message || "This verification link is invalid or has expired. Sign in to request a new one."
              : "One moment."}
        </p>
        {state !== "working" && (
          <Link href="/auth/signin" className="inline-block text-sm text-indigo-400 hover:text-indigo-300">
            Go to sign in
          </Link>
        )}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
