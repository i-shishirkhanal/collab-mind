import { create } from 'zustand';

interface WorkspaceState {
  workspaces: any[];
  activeWorkspace: any | null;
  setWorkspaces: (workspaces: any[]) => void;
  setActiveWorkspace: (workspace: any) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspaces: [],
  activeWorkspace: null,
  setWorkspaces: (workspaces) => set({ workspaces }),
  setActiveWorkspace: (activeWorkspace) => set({ activeWorkspace }),
}));
