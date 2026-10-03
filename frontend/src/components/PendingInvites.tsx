"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { acceptInvite, declineInvite, getMyInvites, type WorkspaceInvite } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

/** Workspace invitations addressed to the signed-in user; joining is always the user's own decision. */
export function PendingInvites({ onAccepted }: { onAccepted: () => void }) {
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMyInvites().then(setInvites).catch(() => setInvites([]));
  }, []);

  const answer = useCallback(async (invite: WorkspaceInvite, accept: boolean) => {
    setBusyId(invite.id);
    setError(null);
    try {
      await (accept ? acceptInvite(invite.id) : declineInvite(invite.id));
      setInvites((list) => list.filter((i) => i.id !== invite.id));
      if (accept) onAccepted();
    } catch (err) {
      setError(errorMessage(err, "Could not answer the invitation."));
    } finally {
      setBusyId(null);
    }
  }, [onAccepted]);

  if (invites.length === 0 && !error) return null;

  return (
    <section aria-label="Workspace invitations" className="rounded-[2rem] bg-slate-900/80 p-5 md:p-6 space-y-3">
      <h2 className="text-lg font-bold text-slate-50">Invitations</h2>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      <ul className="space-y-2">
        {invites.map((invite) => (
          <li key={invite.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 p-3">
            <div className="min-w-0">
              <p className="truncate font-semibold text-slate-100">{invite.workspace_name}</p>
              <p className="text-xs text-slate-400 truncate">
                {invite.invited_by_name ? `${invite.invited_by_name} invited you` : "You were invited"} as {invite.role}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {busyId === invite.id ? (
                <Loader2 className="size-4 animate-spin text-slate-400" />
              ) : (
                <>
                  <button onClick={() => answer(invite, true)} title="Accept" aria-label={`Accept invitation to ${invite.workspace_name}`} className="flex size-8 items-center justify-center rounded-md text-emerald-400 hover:bg-emerald-500/10"><Check className="size-4" /></button>
                  <button onClick={() => answer(invite, false)} title="Decline" aria-label={`Decline invitation to ${invite.workspace_name}`} className="flex size-8 items-center justify-center rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-400"><X className="size-4" /></button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
