"use client";

import { useEffect, useState } from "react";
import { Check, CheckCheck, Download, FileText, Loader2, Reply, Trash2, AlertCircle } from "lucide-react";
import { getAttachmentUrl } from "@/lib/messagingApi";
import { formatBytes } from "@/lib/messagingUtils";
import { cn } from "@/lib/utils";
import type { DirectMessage } from "@/types/messaging";

const isImage = (type?: string) => !!type && /^image\/(png|jpeg|gif|webp)$/.test(type);

function Attachment({ message, mine }: { message: DirectMessage; mine: boolean }) {
  const att = message.attachment!;
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const canFetch = !message.pending && !message.failed;

  // Signed URLs are short-lived, so images are resolved on demand rather than stored.
  useEffect(() => {
    if (!isImage(att.type) || !canFetch) return;
    let cancelled = false;
    getAttachmentUrl(message.conversation_id, message.id)
      .then((r) => !cancelled && setImageUrl(r.url))
      .catch(() => !cancelled && setError(true));
    return () => { cancelled = true; };
  }, [att.type, canFetch, message.conversation_id, message.id]);

  const download = async () => {
    setBusy(true);
    setError(false);
    try {
      const { url } = await getAttachmentUrl(message.conversation_id, message.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      {isImage(att.type) && imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt={att.name} className="rounded-lg max-h-64 max-w-full object-contain" loading="lazy" />
      )}
      <button
        type="button" onClick={download} disabled={!canFetch || busy}
        className={cn(
          "flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs w-full max-w-[16rem] transition-colors",
          mine ? "bg-indigo-700/60 hover:bg-indigo-700" : "bg-slate-700/60 hover:bg-slate-700",
        )}
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : <FileText className="w-4 h-4 shrink-0" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{att.name}</span>
          <span className="opacity-70">{formatBytes(att.size)}</span>
        </span>
        <Download className="w-3.5 h-3.5 shrink-0 opacity-70" />
      </button>
      {error && <span className="text-[11px] text-red-300">Couldn&apos;t load the file. Try again.</span>}
    </div>
  );
}

export function MessageBubble({
  message, mine, showSender, receipt, onReply, onDelete, onRetry,
}: {
  message: DirectMessage;
  mine: boolean;
  showSender: boolean;
  /** "sent" | "read" for own messages; group reads carry a count. */
  receipt?: { state: "sent" | "read"; label?: string };
  onReply: (m: DirectMessage) => void;
  onDelete: (m: DirectMessage) => void;
  onRetry: (m: DirectMessage) => void;
}) {
  if (message.kind === "system") {
    return <div className="text-center text-xs text-slate-500 my-3">{message.body}</div>;
  }

  const time = new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={cn("group flex mb-2", mine ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[85%] sm:max-w-[70%] min-w-0", mine && "flex flex-col items-end")}>
        {showSender && !mine && (
          <div className="text-xs text-indigo-300 mb-0.5 ml-1">{message.sender_name || "Unknown"}</div>
        )}
        <div className="flex items-center gap-1.5">
          {mine && !message.deleted && !message.pending && (
            <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex">
              <button type="button" aria-label="Reply" onClick={() => onReply(message)} className="p-1 text-slate-500 hover:text-slate-200"><Reply className="w-3.5 h-3.5" /></button>
              <button type="button" aria-label="Delete message" onClick={() => onDelete(message)} className="p-1 text-slate-500 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          )}
          <div
            className={cn(
              "px-3.5 py-2 rounded-2xl text-sm break-words whitespace-pre-wrap min-w-0",
              mine ? "bg-indigo-600 text-white rounded-br-sm" : "bg-slate-800 border border-slate-700/50 text-slate-100 rounded-bl-sm",
              message.pending && "opacity-70",
              message.failed && "ring-1 ring-red-500/60",
            )}
          >
            {message.reply_to && (
              <div className={cn("mb-1.5 pl-2 border-l-2 text-xs", mine ? "border-indigo-300/60 text-indigo-100/80" : "border-slate-500 text-slate-400")}>
                <div className="font-medium">{message.reply_to.sender_name || "Unknown"}</div>
                <div className="line-clamp-2">{message.reply_to.body || "Message deleted"}</div>
              </div>
            )}
            {message.deleted ? (
              <span className="italic opacity-70">This message was deleted</span>
            ) : (
              <>
                {message.attachment && <Attachment message={message} mine={mine} />}
                {message.body && <div className={message.attachment ? "mt-1.5" : ""}>{message.body}</div>}
              </>
            )}
          </div>
          {!mine && !message.deleted && (
            <button type="button" aria-label="Reply" onClick={() => onReply(message)} className="p-1 text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity">
              <Reply className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 mt-0.5 mx-1 text-[11px] text-slate-500">
          <span>{time}</span>
          {mine && message.pending && <Loader2 className="w-3 h-3 animate-spin" aria-label="Sending" />}
          {mine && message.failed && (
            <button type="button" onClick={() => onRetry(message)} className="flex items-center gap-1 text-red-400 hover:text-red-300">
              <AlertCircle className="w-3 h-3" /> Failed — retry
            </button>
          )}
          {mine && !message.pending && !message.failed && receipt && (
            <span className={cn("flex items-center gap-0.5", receipt.state === "read" ? "text-indigo-300" : "")} aria-label={receipt.state === "read" ? "Read" : "Sent"}>
              {receipt.state === "read" ? <CheckCheck className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
              {receipt.label}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
