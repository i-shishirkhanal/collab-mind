"use client";

export const dynamic = "force-dynamic";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { resetPassword } from "@/lib/authApi";

function ResetPassword() {
  const token = useSearchParams().get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-slate-200">
      <div className="w-full max-w-[420px] space-y-5 rounded-2xl border border-slate-800 bg-slate-900/90 p-8">
        <h1 className="font-serif text-2xl text-slate-50">Choose a new password</h1>
        {done ? (
          <p className="text-sm text-emerald-400">Password updated. You can now sign in.</p>
        ) : !token ? (
          <p className="text-sm text-red-400">This link is missing its token. Request a new reset email.</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && <p className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">{error}</p>}
            {[["New password", password, setPassword], ["Confirm password", confirm, setConfirm]].map(([label, value, set]) => (
              <input
                key={label as string}
                type="password"
                required
                minLength={10}
                maxLength={128}
                autoComplete="new-password"
                placeholder={`${label} (min 10 characters)`}
                value={value as string}
                onChange={(e) => (set as (v: string) => void)(e.target.value)}
                className="w-full rounded-xl border border-slate-800 bg-slate-950/80 px-4 py-2.5 text-sm text-slate-50 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            ))}
            <Button type="submit" disabled={loading} className="h-11 w-full rounded-xl bg-indigo-600 text-white hover:bg-indigo-500">
              Update password
            </Button>
          </form>
        )}
        <Link href="/auth/signin" className="inline-block text-sm text-indigo-400 hover:text-indigo-300">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPassword />
    </Suspense>
  );
}
