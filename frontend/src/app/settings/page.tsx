"use client";

import { useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { changePassword, deleteAccount, logoutEverywhere } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

const field =
  "w-full rounded-xl border border-slate-800 bg-slate-950/80 px-4 py-2.5 text-sm text-slate-50 placeholder-slate-500 focus:border-indigo-500 focus:outline-none";

type Notice = { kind: "ok" | "error"; text: string } | null;

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const tone = notice.kind === "ok" ? "text-emerald-400" : "text-red-400";
  return <p role={notice.kind === "error" ? "alert" : "status"} className={`text-xs ${tone}`}>{notice.text}</p>;
}

export default function SettingsPage() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwNotice, setPwNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<"pw" | "all" | "delete" | null>(null);
  const [allNotice, setAllNotice] = useState<Notice>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteNotice, setDeleteNotice] = useState<Notice>(null);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwNotice(null);
    if (next !== confirm) {
      setPwNotice({ kind: "error", text: "New passwords do not match." });
      return;
    }
    setBusy("pw");
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setPwNotice({ kind: "ok", text: "Password changed. Your other sessions were signed out." });
    } catch (err) {
      setPwNotice({ kind: "error", text: errorMessage(err, "Could not change the password.") });
    } finally {
      setBusy(null);
    }
  };

  const signOutAll = async () => {
    setBusy("all");
    setAllNotice(null);
    try {
      await logoutEverywhere();
      await signOut({ callbackUrl: "/auth/signin" });
    } catch (err) {
      setAllNotice({ kind: "error", text: errorMessage(err, "Could not sign out everywhere.") });
      setBusy(null);
    }
  };

  const removeAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.confirm("Permanently delete your account and the workspaces only you belong to? This cannot be undone.")) return;
    setBusy("delete");
    setDeleteNotice(null);
    try {
      await deleteAccount(deletePassword);
      await signOut({ callbackUrl: "/auth/signin" });
    } catch (err) {
      setDeleteNotice({ kind: "error", text: errorMessage(err, "Could not delete the account.") });
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 p-4 text-slate-200">
      <div className="mx-auto w-full max-w-xl space-y-6 py-8">
        <Link href="/dashboard" className="inline-flex items-center gap-2 text-xs text-slate-400 hover:text-slate-200">
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Link>
        <h1 className="font-serif text-3xl text-slate-50">Account settings</h1>

        <form onSubmit={submitPassword} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/90 p-6">
          <h2 className="text-lg text-slate-50">Change password</h2>
          <input type="password" required autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} maxLength={128} className={field} />
          <input type="password" required autoComplete="new-password" minLength={10} maxLength={128} placeholder="New password (min 10 characters)" value={next} onChange={(e) => setNext(e.target.value)} className={field} />
          <input type="password" required autoComplete="new-password" minLength={10} maxLength={128} placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
          <NoticeLine notice={pwNotice} />
          <Button type="submit" disabled={busy !== null}>{busy === "pw" ? "Saving…" : "Change password"}</Button>
        </form>

        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/90 p-6">
          <h2 className="text-lg text-slate-50">Sign out everywhere</h2>
          <p className="text-sm text-slate-400">Ends every session on every device, including this one.</p>
          <NoticeLine notice={allNotice} />
          <Button variant="outline" onClick={signOutAll} disabled={busy !== null}>{busy === "all" ? "Signing out…" : "Sign out of all devices"}</Button>
        </section>

        <form onSubmit={removeAccount} className="space-y-3 rounded-2xl border border-red-500/30 bg-slate-900/90 p-6">
          <h2 className="text-lg text-red-300">Delete account</h2>
          <p className="text-sm text-slate-400">
            Removes your account and any workspace only you belong to. If you own a workspace that has other
            members, transfer ownership or remove them first.
          </p>
          <input type="password" required autoComplete="current-password" placeholder="Confirm with your password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} maxLength={128} className={field} />
          <NoticeLine notice={deleteNotice} />
          <Button type="submit" variant="destructive" disabled={busy !== null || !deletePassword}>{busy === "delete" ? "Deleting…" : "Delete my account"}</Button>
        </form>
      </div>
    </div>
  );
}
