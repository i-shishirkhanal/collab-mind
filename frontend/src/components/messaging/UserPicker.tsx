"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { searchUsers } from "@/lib/messagingApi";
import { Initials } from "./Initials";
import type { ChatUser } from "@/types/messaging";

/**
 * Debounced search over people the user shares a workspace with.
 * `selectedIds` highlights picks (multi-select); `excludeIds` hides people already in a group.
 */
export function UserPicker({
  onPick, selectedIds = [], excludeIds = [], autoFocus,
}: {
  onPick: (user: ChatUser) => void;
  selectedIds?: string[];
  excludeIds?: string[];
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChatUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const { users } = await searchUsers(query);
        if (!cancelled) setResults(users);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error && err.message === "CONNECTION_FAILED" ? "Could not reach the server." : "Search failed.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const visible = results.filter((u) => !excludeIds.includes(u.id));

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <Input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search teammates by name or email"
          aria-label="Search people"
          className="pl-8 h-9 bg-slate-800 border-slate-700 text-slate-50 placeholder:text-slate-500"
        />
      </div>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-800 divide-y divide-slate-800/70" role="listbox" aria-label="People">
        {loading && visible.length === 0 && (
          <div className="p-4 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-indigo-400" /></div>
        )}
        {error && <div className="p-3 text-sm text-red-400">{error}</div>}
        {!loading && !error && visible.length === 0 && (
          <div className="p-3 text-sm text-slate-500">
            No one found. You can message people who share a workspace with you.
          </div>
        )}
        {visible.map((u) => {
          const selected = selectedIds.includes(u.id);
          return (
            <button
              key={u.id}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => onPick(u)}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-800/70 transition-colors"
            >
              <Initials name={u.name} src={u.avatar_url} className="w-8 h-8" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-slate-100 truncate">{u.name}</span>
                <span className="block text-xs text-slate-500 truncate">{u.email}</span>
              </span>
              {selected && <Check className="w-4 h-4 text-indigo-400" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
