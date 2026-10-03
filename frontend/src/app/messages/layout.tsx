"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ConversationList } from "@/components/messaging/ConversationList";

/**
 * Two-pane messenger. On phones only one pane is visible at a time:
 * /messages shows the list, /messages/<id> (or /calls) shows the content pane.
 */
export default function MessagesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const atRoot = pathname === "/messages";

  return (
    <div className="flex h-screen bg-transparent overflow-hidden text-slate-50">
      <aside
        className={`${atRoot ? "flex" : "hidden"} md:flex w-full md:w-[320px] lg:w-[360px] flex-col shrink-0 bg-slate-900 border-r border-slate-800/60`}
      >
        <div className="px-4 pt-3 shrink-0">
          <Link href="/dashboard" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
            <ArrowLeft className="w-3 h-3" /> Workspaces
          </Link>
        </div>
        <div className="flex-1 min-h-0">
          <ConversationList />
        </div>
      </aside>
      <main className={`${atRoot ? "hidden" : "flex"} md:flex flex-1 min-w-0 flex-col`}>{children}</main>
    </div>
  );
}
