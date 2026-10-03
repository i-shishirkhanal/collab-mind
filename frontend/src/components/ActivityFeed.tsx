import Link from "next/link";
import { Bot, FileText, MessageSquare } from "lucide-react";
import { ActivityItem } from "@/types";
import { timeAgo } from "@/lib/utils";

const AGENT_STATUS: Record<string, string> = {
  analyzing: "is analysing sources",
  planning: "is drafting a plan",
  awaiting_approval: "is waiting for approval",
  generating: "is generating materials",
  done: "finished",
  failed: "failed",
};

function describe(item: ActivityItem) {
  const who = item.actor_name || "Someone";
  switch (item.kind) {
    case "question":
      return { icon: MessageSquare, text: `${who} asked: ${item.label}` };
    case "source":
      return {
        icon: FileText,
        text: `${who} added ${item.label}${item.status === "failed" ? " (processing failed)" : ""}`,
      };
    default:
      return {
        icon: Bot,
        text: `Study coach run ${AGENT_STATUS[item.status ?? ""] ?? item.status ?? ""}`.trim(),
      };
  }
}

export function ActivityFeed({ items }: { items: ActivityItem[] | null }) {
  return (
    <section className="rounded-[2rem] bg-white p-5 shadow-[0_10px_30px_-18px_rgba(107,70,232,0.5)]">
      <h2 className="text-lg font-bold text-slate-50">Recent activity</h2>
      {items === null ? (
        <div className="mt-4 space-y-3" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-xl bg-slate-950" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">
          Questions, uploads and study-coach runs will show up here.
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {items.map((item, i) => {
            const { icon: Icon, text } = describe(item);
            return (
              <li key={`${item.created_at}-${i}`}>
                <Link
                  href={`/workspace/${item.workspace_id}`}
                  className="group flex items-start gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-indigo-500"
                >
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="line-clamp-2 text-sm text-slate-100 group-hover:text-indigo-500">{text}</span>
                    <span className="block truncate text-xs text-slate-400">
                      {item.workspace_name} · {timeAgo(item.created_at)}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
