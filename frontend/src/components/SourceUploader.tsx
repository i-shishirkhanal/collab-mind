"use client";

import { useState, useRef } from "react";
import { UploadCloud, Link as LinkIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uploadFile, addUrl } from "@/lib/api";
import { useWorkspaceStore } from "@/lib/store";

export function SourceUploader({ workspaceId }: { workspaceId: string }) {
  const [isDragging, setIsDragging] = useState(false);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const refetchSources = async () => {
    // Basic reload mechanism, ideally we'd call the hook's refetch, 
    // but here we just let page polling pick it up or push a dummy refresh
    window.dispatchEvent(new Event('sources-updated'));
  };

  const handleFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    performUpload(e.dataTransfer.files[0]);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    performUpload(e.target.files[0]);
  };

  const performUpload = async (file: File) => {
    setLoading(true);
    try {
      await uploadFile(workspaceId, file);
      refetchSources();
    } catch (err) {
      console.error("Upload failed", err);
    } finally {
      setLoading(false);
    }
  };

  const handleUrlSubmit = async () => {
    if (!url.trim()) return;
    setLoading(true);
    try {
      await addUrl(workspaceId, url);
      setUrl("");
      refetchSources();
    } catch (err) {
      console.error("URL add failed", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Drag & Drop Zone */}
      <div 
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleFileDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-colors ${
          isDragging 
            ? "border-indigo-500 bg-indigo-500/10" 
            : "border-slate-700 hover:border-slate-600 hover:bg-slate-800/50 bg-slate-900/50"
        }`}
      >
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          onChange={handleFileSelect}
          accept=".pdf,.docx,.txt"
        />
        <div className="flex flex-col items-center justify-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 mb-2">
            {loading ? <Loader2 className="w-6 h-6 animate-spin text-indigo-500" /> : <UploadCloud className="w-6 h-6" />}
          </div>
          <div>
            <span className="font-semibold text-indigo-400">Click to upload</span>
            <span className="text-slate-400"> or drag and drop</span>
          </div>
          <p className="text-xs text-slate-500">PDF, DOCX, or TXT (Max 50MB)</p>
        </div>
      </div>

      {/* URL Input */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <LinkIcon className="h-4 w-4 text-slate-500" />
          </div>
          <Input 
            placeholder="Paste a secure web link (e.g. https://docs.google.com/...)" 
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="pl-10 bg-slate-900 border-slate-700 text-slate-100 placeholder:text-slate-600"
          />
        </div>
        <Button 
          onClick={handleUrlSubmit} 
          disabled={!url.trim() || loading}
          className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 shrink-0"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : "Add URL"}
        </Button>
      </div>
    </div>
  );
}
