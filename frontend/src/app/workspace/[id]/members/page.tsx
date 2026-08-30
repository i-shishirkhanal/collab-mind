"use client";

import { use } from "react";
import { useWorkspaceStore, usePresenceStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export default function MembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const members = useWorkspaceStore(s => s.members);
  const onlineMembers = usePresenceStore(s => s.onlineMembers);
  
  // Here we would typically also get the current user's role to determine if they can remove/invite 
  // For demo, we assume they can if they are the owner
  const isOwner = true; // placeholder

  return (
    <div className="h-full overflow-y-auto bg-slate-950 custom-scrollbar p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Team Members</h1>
            <p className="text-sm text-slate-400 mt-1">Manage access to this collaborative workspace.</p>
          </div>
        </div>

        {isOwner && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm flex flex-col sm:flex-row gap-4">
            <div className="flex-1 space-y-2">
              <label className="text-sm font-medium text-slate-300">Invite a new member</label>
              <div className="flex gap-2">
                <Input 
                  placeholder="name@company.com" 
                  className="bg-slate-800 border-slate-700 text-white flex-1"
                />
                <select className="bg-slate-800 border border-slate-700 rounded-md text-slate-200 px-3 text-sm focus:ring-1 focus:ring-indigo-500 outline-none w-32">
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                  <option value="admin">Admin</option>
                </select>
                <Button className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium">
                  Send Invite
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden shadow-sm">
          <ul className="divide-y divide-slate-800/60">
            {members.map(member => {
              const isOnline = onlineMembers.includes(member.user_id);
              return (
                <li key={member.id} className="p-4 flex items-center justify-between hover:bg-slate-800/30 transition-colors">
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <div className="w-10 h-10 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 font-bold flex items-center justify-center uppercase shadow-sm">
                        {member.name.substring(0, 2)}
                      </div>
                      {isOnline && (
                         <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-slate-900 rounded-full shadow-sm"></div>
                      )}
                    </div>
                    <div>
                      <h4 className="font-semibold text-slate-200">{member.name}</h4>
                      <p className="text-xs text-slate-400">{member.email}</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-4">
                    <Badge variant="outline" className="capitalize text-slate-300 border-slate-700 bg-slate-800/50">
                      {member.role}
                    </Badge>
                    
                    {isOwner && member.role !== 'owner' && (
                      <select className="bg-slate-800 border border-slate-700 rounded-md text-slate-300 text-xs px-2 py-1 outline-none">
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                        <option value="admin">Admin</option>
                        <option value="remove" className="text-red-400">Remove</option>
                      </select>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        
      </div>
    </div>
  );
}
