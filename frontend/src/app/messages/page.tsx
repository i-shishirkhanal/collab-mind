import { MessageSquare } from "lucide-react";

export default function MessagesIndexPage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center text-slate-500 p-6">
      <MessageSquare className="w-10 h-10 mb-3 text-slate-700" />
      <p className="text-slate-300 font-medium">Select a conversation</p>
      <p className="text-sm">or start a new one to chat, share files, or call.</p>
    </div>
  );
}
