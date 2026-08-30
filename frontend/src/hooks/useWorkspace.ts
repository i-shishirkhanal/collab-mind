"use client";

import { useEffect, useState, useCallback } from 'react';
import { getWorkspace, getMembers, getSources } from '@/lib/api';
import { useWorkspaceStore } from '@/lib/store';

export const useWorkspace = (workspaceId: string) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const workspace = useWorkspaceStore(s => s.workspace);
  const members = useWorkspaceStore(s => s.members);
  const sources = useWorkspaceStore(s => s.sources);
  
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace);
  const setMembers = useWorkspaceStore(s => s.setMembers);
  const setSources = useWorkspaceStore(s => s.setSources);

  const fetchAll = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [wsData, mData, sData] = await Promise.allSettled([
        getWorkspace(workspaceId),
        getMembers(workspaceId),
        getSources(workspaceId)
      ]);

      if (wsData.status === 'fulfilled' && wsData.value) {
        setWorkspace(wsData.value);
      } else {
        // Backend unreachable - create a minimal fallback workspace so UI doesn't hang
        console.warn("Could not fetch workspace, using fallback");
        setWorkspace({
          id: workspaceId,
          name: "Workspace",
          description: "Backend unavailable – data may not be fully loaded.",
          owner_id: "unknown",
          member_count: 0,
          source_count: 0,
        });
        setError("Backend unavailable. Some features may not work.");
      }

      if (mData.status === 'fulfilled' && mData.value) {
        setMembers(mData.value.members || []);
      } else {
        setMembers([]);
      }

      if (sData.status === 'fulfilled' && sData.value) {
        setSources(sData.value.sources || []);
      } else {
        setSources([]);
      }
    } catch (err) {
      console.error("Failed to load workspace data:", err);
      // Still set a fallback so the loading spinner goes away
      setWorkspace({
        id: workspaceId,
        name: "Workspace",
        description: "Connection error.",
        owner_id: "unknown",
        member_count: 0,
        source_count: 0,
      });
      setMembers([]);
      setSources([]);
      setError("Failed to connect to the backend server.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, setWorkspace, setMembers, setSources]);

  const refetchSources = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const sData = await getSources(workspaceId);
      setSources(sData.sources || []);
    } catch (err) {
      console.error(err);
    }
  }, [workspaceId, setSources]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return { workspace, members, sources, loading, error, refetchSources };
};
