import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  isOnline: boolean;
}

export function MemberList({ members }: { members: Member[] }) {
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-2">Team Members — {members.length}</h3>
      <div className="space-y-1">
        {members.map((member) => (
          <div key={member.id} className="flex items-center justify-between p-2 rounded-lg hover:bg-slate-800/50 transition-colors group">
            <div className="flex items-center gap-3">
              <div className="relative">
                <Avatar className="w-8 h-8 border border-slate-700">
                  <AvatarFallback className="bg-slate-700 text-slate-300 text-xs font-medium">
                    {member.name.substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-slate-900 ${member.isOnline ? 'bg-emerald-500' : 'bg-slate-500'}`} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-200 truncate">{member.name}</p>
                <p className="text-xs text-slate-500 truncate">{member.email}</p>
              </div>
            </div>
            
            <div className="flex gap-2 items-center">
              {member.role === 'admin' && (
                <Badge variant="outline" className="text-[10px] uppercase tracking-wider border-slate-700/50 text-slate-400 bg-slate-800/50 flex-none">Admin</Badge>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
