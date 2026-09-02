"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, getErrorMessage } from "@/lib/api";
import type { ProjectDetail } from "@/lib/types";
import { useApiStatus } from "@/components/providers";

interface ProjectContextValue {
  projectId: string;
  project?: ProjectDetail;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  refresh: () => Promise<ProjectDetail | undefined>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const [project, setProject] = useState<ProjectDetail>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const { check } = useApiStatus();

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api.getProject(projectId);
      setProject(next);
      setError(undefined);
      return next;
    } catch (caught) {
      setError(getErrorMessage(caught));
      void check();
      return undefined;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [check, projectId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ projectId, project, loading, refreshing, error, refresh }),
    [projectId, project, loading, refreshing, error, refresh],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used within ProjectProvider");
  return value;
}
