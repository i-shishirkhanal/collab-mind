"use client";

import React, { useState, useRef, useEffect } from "react";
import { Send, Loader2 } from "lucide-react";

import { useChatStore, usePresenceStore } from "@/lib/store";
import { getChatHistory, sendChat } from "@/lib/api";
import { ChatMessage } from "./ChatMessage";
import { CitationPanel } from "./CitationPanel";
import { useSocketContext } from "@/hooks/SocketProvider";

export function ChatInterface({ workspaceId }: { workspaceId: string }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const messages = useChatStore(s => s.messages);
  const addMessage = useChatStore(s => s.addMessage);
  const replaceMessage = useChatStore(s => s.replaceMessage);
  const setMessages = useChatStore(s => s.setMessages);
  const isLoading = useChatStore(s => s.isLoading);
  const setLoading = useChatStore(s => s.setLoading);
  const activeCitation = useChatStore(s => s.activeCitation);
  const setActiveCitation = useChatStore(s => s.setActiveCitation);
  const typingUsers = usePresenceStore(s => s.typingUsers);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Socket is initialized by the workspace layout's SocketProvider; reuse it here
  const { sendTyping } = useSocketContext();
  const typingStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);

  // Fetch initial history
  useEffect(() => {
    getChatHistory(workspaceId).then(data => {
      if (data.messages) {
        setMessages(data.messages);
      }
    }).catch(console.error);
  }, [workspaceId, setMessages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const autoResize = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMsg = {
      id: `local-${Date.now()}`,
      workspace_id: workspaceId,
      user_id: "local_user",
      content: input.trim(),
      role: 'user' as const,
      created_at: new Date().toISOString()
    };

    addMessage(userMsg);
    setInput("");
    setError(null);
    setLoading(true);
    sendTyping(false);
    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'; // Reset size
    }

    try {
      // The answer also arrives as a 'chat:message' socket event, but that only reaches us if the
      // socket has already joined the workspace room. The REST response is authoritative, so use it
      // too; messages are merged by id, so receiving both is harmless.
      // History is read from the server-side conversation; nothing is sent from here.
      const result = await sendChat(workspaceId, userMsg.content);
      if (result?.userMessage) replaceMessage(userMsg.id, result.userMessage);
      if (result?.aiMessage) addMessage(result.aiMessage);
    } catch (err) {
      console.error(err);
      // The backend does not keep a question whose answer failed, so tell the user to resend it.
      const code = err instanceof Error ? err.message : "";
      setError(
        code === "CONNECTION_FAILED" ? "Could not reach the server. Check your connection and try again."
        : code && code !== "UNAUTHORIZED" ? `${code} Your message was not saved; please send it again.`
        : "Something went wrong. Please try again."
      );
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else {
      // typing indicator could be sent via socket if needed
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-950 relative overflow-hidden">
      
      {/* Shared Chat Banner */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
        <div className="bg-slate-800/90 backdrop-blur border border-slate-700/50 shadow-sm text-slate-300 text-xs px-4 py-1.5 rounded-full font-medium flex items-center shadow-lg">
          <svg className="w-3.5 h-3.5 mr-1.5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
          Chat history is visible to all workspace members
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar p-6 pt-20">
        <div className="max-w-4xl mx-auto pb-4">
          {messages.map((m) => (
            <ChatMessage key={m.id} message={m} />
          ))}

          {isLoading && (
            <div className="flex justify-start mb-6 w-full">
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-indigo-900/50 border-2 border-indigo-500/50 flex items-center justify-center shrink-0">
                  <span className="text-xs font-bold text-indigo-400">CM</span>
                </div>
                <div className="px-5 py-3.5 rounded-2xl bg-slate-800 border border-slate-700/50 rounded-tl-sm flex items-center gap-1.5">
                  <span className="text-slate-400 text-sm mr-2 italic">CollabMind AI is thinking</span>
                  <div className="flex gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '0ms' }}></div>
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '150ms' }}></div>
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '300ms' }}></div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div role="alert" className="mb-4 ml-12 max-w-xl rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
              {error}
            </div>
          )}

          {typingUsers.length > 0 && (
            <div className="flex items-center gap-2 mb-4 pl-12 text-xs text-slate-500">
              <div className="flex gap-1">
                <div className="w-1 h-1 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-1 h-1 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-1 h-1 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
              <span className="italic">
                {typingUsers.length === 1
                  ? `${typingUsers[0].name} is typing…`
                  : `${typingUsers.map(u => u.name).join(', ')} are typing…`}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Input Area */}
      <div className="p-4 bg-slate-900/50 backdrop-blur-md border-t border-slate-800/60 shrink-0 select-none">
        <div className="max-w-4xl mx-auto relative group">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoResize();
              const now = Date.now();
              if (now - lastTypingSent.current > 1500) {
                lastTypingSent.current = now;
                sendTyping(true);
              }
              if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
              typingStopTimer.current = setTimeout(() => sendTyping(false), 2000);
            }}
            onKeyDown={onKeyDown}
            placeholder="Ask anything about your workspace sources... (Shift+Enter for newline)"
            className="w-full bg-slate-800 border border-slate-700 rounded-2xl pl-5 pr-14 py-4 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 resize-none overflow-hidden custom-scrollbar transition-shadow shadow-sm"
            rows={1}
            style={{ minHeight: '56px', maxHeight: '120px' }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className="absolute right-3 bottom-0 top-0 my-auto h-10 w-10 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl flex items-center justify-center transition-all shadow-md group-focus-within:bg-indigo-600 hover:shadow-indigo-500/20"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4 ml-0.5" />}
          </button>
        </div>
        <div className="text-center mt-2">
          <span className="text-[11px] text-slate-500">AI can make mistakes. Verify anything critical against the source.</span>
        </div>
      </div>

      {/* Citation Slide-in Panel */}
      <CitationPanel citation={activeCitation} onClose={() => setActiveCitation(null)} />

      {/* Optional dark overlay when panel opens on smaller screens */}
      {activeCitation && (
        <div 
          className="fixed inset-0 bg-slate-950/20 backdrop-blur-sm z-40 lg:hidden"
          onClick={() => setActiveCitation(null)}
        />
      )}
    </div>
  );
}
