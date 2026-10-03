"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, MessageSquarePlus, Phone, Search, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useMessaging } from "@/hooks/MessagingProvider";
import { useMessagingStore } from "@/store/messagingStore";
import { conversationDisplay, formatShortTime, lastMessagePreview } from "@/lib/messagingUtils";
import { cn } from "@/lib/utils";
import { Initials } from "./Initials";
import { NewConversationDialog } from "./NewConversationDialog";

export function ConversationList() {
  const pathname = usePathname();
  const { myUserId, connected } = useMessaging();
  const conversations = useMessagingStore((s) => s.conversations);
  const loaded = useMessagingStore((s) => s.conversationsLoaded);
  const online = useMessagingStore((s) => s.onlineUserIds);
  const typing = useMessagingStore((s) => s.typing);
  const [filter, setFilter] = useState("");

  const items = conversations
    .map((c) => ({ c, d: conversationDisplay(c, myUserId) }))
    .filter(({ d }) => d.title.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="h-16 px-4 flex items-center justify-between border-b border-slate-800/60 shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-slate-50 leading-tight">Messages</h1>
          <p className="text-[11px] leading-none text-slate-500">{connected ? "Live" : "Connecting…"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/messages/calls" aria-label="Call history" title="Call history"
            className={cn("p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors", pathname === "/messages/calls" && "bg-slate-800 text-slate-100")}
          >
            <Phone className="w-4 h-4" />
          </Link>
          <NewConversationDialog />
        </div>
      </div>

      <div className="p-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <Input
            value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search conversations"
            aria-label="Search conversations"
            className="pl-8 h-9 bg-slate-800 border-slate-700 text-slate-50 placeholder:text-slate-500"
          />
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto px-2 pb-3 space-y-0.5" aria-label="Conversations">
        {!loaded && (
          <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-indigo-500" /></div>
        )}
        {loaded && items.length === 0 && (
          <div className="text-center text-sm text-slate-500 py-10 px-4">
            <MessageSquarePlus className="w-8 h-8 mx-auto mb-2 text-slate-600" />
            {filter ? "No conversations match." : "No conversations yet. Start one with the New button."}
          </div>
        )}
        {items.map(({ c, d }) => {
          const active = pathname === `/messages/${c.id}`;
          const someoneTyping = Object.keys(typing[c.id] || {}).length > 0;
          const unread = c.unread_count ?? 0;
          return (
            <Link
              key={c.id} href={`/messages/${c.id}`} aria-current={active ? "page" : undefined}
              className={cn("flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors", active ? "bg-indigo-500/10" : "hover:bg-slate-800/70")}
            >
              {c.type === "group" ? (
                <div className="w-10 h-10 rounded-full bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
                  <Users className="w-4 h-4 text-indigo-300" />
                </div>
              ) : (
                <Initials name={d.title} src={d.avatar} online={d.otherUserId ? online.includes(d.otherUserId) : false} />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate text-sm", unread > 0 ? "font-semibold text-slate-50" : "font-medium text-slate-200")}>{d.title}</span>
                  <span className="text-[11px] text-slate-500 shrink-0">{formatShortTime(c.last_message_at)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className={cn("truncate text-xs", someoneTyping ? "text-indigo-300 italic" : "text-slate-500")}>
                    {someoneTyping ? "typing…" : lastMessagePreview(c.last_message, myUserId)}
                  </span>
                  {unread > 0 && (
                    <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-indigo-600 text-white text-[11px] font-semibold flex items-center justify-center" aria-label={`${unread} unread`}>
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
