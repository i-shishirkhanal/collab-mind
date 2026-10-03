import { ChatInterface } from "@/components/ChatInterface";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col h-full bg-slate-950">
      <header className="px-6 py-4 border-b border-slate-800/60 flex flex-col md:flex-row md:items-center justify-between bg-slate-900/50 backdrop-blur-sm z-20 sticky top-0 shrink-0 hidden md:flex">
        <div>
          <h2 className="text-lg font-semibold text-slate-50">Engineering Assistant</h2>
          <p className="text-xs text-slate-400">Powered by CollabMind RAG</p>
        </div>
      </header>

      <ChatInterface workspaceId={id} />
    </div>
  );
}
