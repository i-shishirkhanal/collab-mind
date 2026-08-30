"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createWorkspace } from "@/lib/api";
import { Plus, Loader2 } from "lucide-react";

export function CreateWorkspaceDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      const workspace = await createWorkspace(name, description);
      setOpen(false);
      router.push(`/workspace/${workspace.id}`);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={
        <Button className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/20 font-medium" />
      }>
        <Plus className="mr-2 h-4 w-4" /> New Workspace
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px] bg-slate-900 border-slate-800 text-white">
        <DialogHeader>
          <DialogTitle className="text-xl">Create Workspace</DialogTitle>
          <DialogDescription className="text-slate-400">
            Set up a new collaborative environment for your team.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="name" className="text-slate-300">Workspace Name</Label>
            <Input 
              id="name" 
              value={name} 
              onChange={(e) => setName(e.target.value)} 
              placeholder="e.g. Q3 Engineering" 
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
              required 
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="desc" className="text-slate-300">Description</Label>
            <Input 
              id="desc" 
              value={description} 
              onChange={(e) => setDescription(e.target.value)} 
              placeholder="What is this workspace for?" 
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
            />
          </div>
          <div className="flex justify-end pt-4 gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} className="border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800">
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || loading} className="bg-indigo-600 hover:bg-indigo-700 text-white">
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
