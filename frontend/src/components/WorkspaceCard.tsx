import Link from "next/link";
import { ArrowRight, FileText, Users } from "lucide-react";
import { Workspace } from "@/types";

interface WorkspaceCardProps {
  workspace: Workspace;
  role: string; // The current user's role in this workspace
  index?: number;
}

const roleStyles: Record<string, string> = {
  owner: "bg-indigo-500/10 text-indigo-300",
  admin: "bg-purple-500/10 text-purple-500",
  editor: "bg-purple-500/10 text-purple-500",
  viewer: "bg-slate-500/10 text-slate-400",
};

export function WorkspaceCard({ workspace, role, index = 0 }: WorkspaceCardProps) {
  const badgeClass = roleStyles[role] || roleStyles.viewer;

  return (
    <Link
      href={`/workspace/${workspace.id}`}
      className="group flex items-center gap-4 rounded-full bg-white p-3 shadow-[0_10px_30px_-14px_rgba(107,70,232,0.4)] transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-indigo-500"
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-base font-bold text-indigo-400 ring-1 ring-indigo-500/20">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-base font-bold text-slate-50">{workspace.name}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${badgeClass}`}>
            {role}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-4 text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <Users className="size-3.5" /> {workspace.member_count} Members
          </span>
          <span className="flex items-center gap-1.5">
            <FileText className="size-3.5" /> {workspace.source_count} Sources
          </span>
        </span>
        {workspace.description && (
          <span className="mt-1 block truncate text-xs text-slate-500">{workspace.description}</span>
        )}
      </span>
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-slate-950 text-slate-50 transition-colors group-hover:bg-indigo-600 group-hover:text-white">
        <ArrowRight className="size-4" />
      </span>
    </Link>
  );
}
