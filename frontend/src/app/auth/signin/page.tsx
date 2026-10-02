"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Mail, Lock, User, AlertCircle, ArrowRight, CheckCircle2 } from "lucide-react";
import { registerAccount, resendVerification } from "@/lib/authApi";

const inputClass =
  "w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-950/80 border border-slate-800 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors";

// NextAuth surfaces the error code of a thrown CredentialsSignin as `code`.
const SIGN_IN_ERRORS: Record<string, string> = {
  email_not_verified: "Please verify your email address first. Check your inbox for the verification link.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  service_unavailable: "The server is unavailable right now. Please try again shortly.",
};

export default function SignIn() {
  const router = useRouter();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const switchMode = (signUp: boolean) => {
    setIsSignUp(signUp);
    setError(null);
    setNotice(null);
    setNeedsVerification(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setNeedsVerification(false);
    setLoading(true);

    try {
      if (isSignUp) {
        const res = await registerAccount(email, password, name);
        setNotice(res.message || "Check your email for a verification link, then sign in.");
        setIsSignUp(false);
        setPassword("");
        return;
      }

      const res = await signIn("credentials", { email, password, redirect: false });
      if (res?.error) {
        const code = (res as { code?: string }).code;
        if (code === "email_not_verified") setNeedsVerification(true);
        setError(
          (code && SIGN_IN_ERRORS[code]) || "Invalid email or password."
        );
      } else if (res?.ok) {
        router.push("/dashboard");
        router.refresh();
      }
    } catch (err: any) {
      setError(err?.message || "An unexpected authentication error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    try {
      const res = await resendVerification(email);
      setNotice(res.message || "A new verification link has been sent.");
      setError(null);
      setNeedsVerification(false);
    } catch (err: any) {
      setError(err?.message || "Could not send the email.");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4 font-sans antialiased">
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-indigo-600/15 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-1/4 left-1/2 -translate-x-1/2 translate-y-1/2 w-80 h-80 bg-blue-600/10 blur-[100px] rounded-full pointer-events-none" />

      <div className="mx-auto flex w-full max-w-[420px] flex-col justify-center space-y-6 bg-slate-900/90 backdrop-blur-xl p-8 sm:p-10 rounded-2xl border border-slate-800 shadow-2xl relative overflow-hidden z-10">
        <div className="flex flex-col space-y-2 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/10 border border-indigo-500/20 shadow-inner">
            <span className="text-indigo-400 font-bold text-2xl tracking-tighter">CM</span>
          </div>
          <h1 className="text-2xl font-serif font-semibold tracking-tight text-white">
            {isSignUp ? "Create an account" : "Welcome back"}
          </h1>
          <p className="text-sm text-slate-400">
            {isSignUp
              ? "Join CollabMind AI to start building research workspaces"
              : "Sign in to access your AI research workspace"}
          </p>
        </div>

        <div className="flex rounded-xl bg-slate-950/60 p-1 border border-slate-800/80">
          <button
            type="button"
            onClick={() => switchMode(false)}
            className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all ${
              !isSignUp ? "bg-indigo-600 text-white shadow-md" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => switchMode(true)}
            className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all ${
              isSignUp ? "bg-indigo-600 text-white shadow-md" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Sign Up
          </button>
        </div>

        {notice && (
          <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{notice}</span>
          </div>
        )}

        {error && (
          <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              {error}
              {needsVerification && (
                <button type="button" onClick={handleResend} className="ml-2 underline">
                  Resend link
                </button>
              )}
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignUp && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Full Name</label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  type="text"
                  placeholder="John Doe"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={100}
                  autoComplete="name"
                  className={inputClass}
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Email Address</label>
            <div className="relative">
              <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className={inputClass}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-300">Password</label>
              {!isSignUp && (
                <Link href="/auth/forgot-password" className="text-xs text-indigo-400 hover:text-indigo-300">
                  Forgot password?
                </Link>
              )}
            </div>
            <div className="relative">
              <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="password"
                placeholder={isSignUp ? "At least 10 characters" : "••••••••"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={isSignUp ? 10 : undefined}
                maxLength={128}
                autoComplete={isSignUp ? "new-password" : "current-password"}
                className={inputClass}
              />
            </div>
          </div>

          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-medium shadow-lg shadow-indigo-600/25 h-11 rounded-xl transition-all flex items-center justify-center gap-2 mt-2"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <span>{isSignUp ? "Create Account" : "Sign In"}</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
