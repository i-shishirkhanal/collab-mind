"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requestPasswordReset } from "@/lib/authApi";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await requestPasswordReset(email);
      setMessage(res.message || "If an account exists for this email, a reset link has been sent.");
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-slate-200">
      <div className="w-full max-w-[420px] space-y-5 rounded-2xl border border-slate-800 bg-slate-900/90 p-8">
        <h1 className="font-serif text-2xl text-white">Reset your password</h1>
        <p className="text-sm text-slate-400">
          Enter your email and we&apos;ll send a link to choose a new password. This also verifies accounts that
          have never had a password.
        </p>
        {message && <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-400">{message}</p>}
        {error && <p className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">{error}</p>}
        <form onSubmit={submit} className="space-y-4">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-slate-800 bg-slate-950/80 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
          <Button type="submit" disabled={loading} className="h-11 w-full rounded-xl bg-indigo-600 text-white hover:bg-indigo-500">
            Send reset link
          </Button>
        </form>
        <Link href="/auth/signin" className="inline-block text-sm text-indigo-400 hover:text-indigo-300">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
