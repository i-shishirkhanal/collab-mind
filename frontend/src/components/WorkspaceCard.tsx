import Link from "next/link";
import { Workspace } from "@/types";
import { Badge } from "@/components/ui/badge";

interface WorkspaceCardProps {
  workspace: Workspace;
  role: string; // The current user's role in this workspace
}

export function WorkspaceCard({ workspace, role }: WorkspaceCardProps) {
  const roleColors: Record<string, string> = {
    owner: "text-indigo-400 bg-indigo-500/10 border-indigo-500/20",
    admin: "text-purple-400 bg-purple-500/10 border-purple-500/20",
    editor: "text-purple-400 bg-purple-500/10 border-purple-500/20",
    viewer: "text-slate-400 bg-slate-500/10 border-slate-500/20",
  };

  const badgeClass = roleColors[role] || roleColors["viewer"];

  return (
    <Link href={`/workspace/${workspace.id}`}>
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 h-full flex flex-col hover:border-indigo-500/50 hover:bg-slate-800/80 transition-all cursor-pointer shadow-sm group">
        <div className="flex items-start justify-between mb-2">
          <h3 className="text-lg font-medium text-slate-100 group-hover:text-white transition-colors">
            {workspace.name}
          </h3>
          <Badge variant="outline" className={`capitalize shrink-0 ${badgeClass}`}>
            {role}
          </Badge>
        </div>
        <p className="text-sm text-slate-400 line-clamp-2 flex-grow mb-6">
          {workspace.description}
        </p>
        <div className="mt-auto flex items-center gap-4 text-xs font-medium text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-600"></span>
            {workspace.member_count} Members
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-600"></span>
            {workspace.source_count} Sources
          </span>
        </div>
      </div>
    </Link>
  );
}
