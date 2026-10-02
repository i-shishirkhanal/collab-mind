"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Paperclip, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/messagingUtils";
import type { DirectMessage } from "@/types/messaging";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_LENGTH = 4000;
const TYPING_STOP_MS = 2000;

export function MessageComposer({
  disabled, replyTo, onCancelReply, onSendText, onSendFile, onTyping,
}: {
  disabled?: boolean;
  replyTo: DirectMessage | null;
  onCancelReply: () => void;
  onSendText: (text: string) => void;
  onSendFile: (file: File, caption: string) => Promise<void>;
  onTyping: (isTyping: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingActive = useRef(false);

  useEffect(() => () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
  }, []);

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  const stopTyping = () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    if (typingActive.current) {
      typingActive.current = false;
      onTyping(false);
    }
  };

  const handleChange = (value: string) => {
    setText(value);
    if (value.trim()) {
      if (!typingActive.current) {
        typingActive.current = true;
        onTyping(true);
      }
      if (stopTimer.current) clearTimeout(stopTimer.current);
      stopTimer.current = setTimeout(stopTyping, TYPING_STOP_MS);
    } else {
      stopTyping();
    }
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    }
  };

  const pickFile = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (f.size > MAX_BYTES) {
      setError(`That file is ${formatBytes(f.size)}; the limit is 25 MB.`);
      return;
    }
    setFile(f);
  };

  const submit = async () => {
    if (disabled || uploading) return;
    const body = text.trim();
    if (file) {
      setUploading(true);
      setError(null);
      try {
        await onSendFile(file, body);
        setFile(null);
        setText("");
        stopTyping();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploading(false);
      }
      return;
    }
    if (!body) return;
    onSendText(body);
    setText("");
    stopTyping();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  return (
    <div className="border-t border-slate-800/60 bg-slate-900/60 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0">
      {replyTo && (
        <div className="mb-2 flex items-start gap-2 pl-3 border-l-2 border-indigo-500 text-xs text-slate-400">
          <div className="min-w-0 flex-1">
            <div className="text-indigo-300 font-medium">Replying to {replyTo.sender_name || "message"}</div>
            <div className="truncate">{replyTo.body || replyTo.attachment?.name}</div>
          </div>
          <button type="button" aria-label="Cancel reply" onClick={onCancelReply} className="p-0.5 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
      )}
      {file && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-slate-300">
          <Paperclip className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate flex-1">{file.name}</span>
          <span className="text-slate-500">{formatBytes(file.size)}</span>
          <button type="button" aria-label="Remove attachment" disabled={uploading} onClick={() => setFile(null)} className="hover:text-white"><X className="w-4 h-4" /></button>
        </div>
      )}
      {error && <p className="mb-2 text-xs text-red-400" role="alert">{error}</p>}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef} type="file" className="hidden"
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv,application/zip,audio/*,video/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }}
        />
        <Button type="button" variant="ghost" size="icon-lg" aria-label="Attach file" disabled={disabled || uploading} onClick={() => fileInputRef.current?.click()} className="text-slate-400 hover:text-slate-100">
          <Paperclip />
        </Button>
        <textarea
          ref={textareaRef} value={text} rows={1} maxLength={MAX_LENGTH} disabled={disabled}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={stopTyping}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={file ? "Add a caption (optional)" : "Write a message"}
          aria-label="Message"
          className="flex-1 resize-none rounded-xl bg-slate-800 border border-slate-700 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500 max-h-36"
        />
        <Button
          type="button" size="icon-lg" aria-label="Send message" onClick={submit}
          disabled={disabled || uploading || (!text.trim() && !file)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl"
        >
          {uploading ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>
    </div>
  );
}
