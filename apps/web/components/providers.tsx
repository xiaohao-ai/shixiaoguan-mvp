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
import { api } from "@/lib/api";
import type { AgentMode } from "@/lib/types";

type ConnectionState = "checking" | "online" | "offline";

interface ApiStatusContextValue {
  state: ConnectionState;
  agentMode?: AgentMode;
  lastChecked?: Date;
  check: () => Promise<boolean>;
}

const ApiStatusContext = createContext<ApiStatusContextValue | null>(null);

export function Providers({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnectionState>("checking");
  const [agentMode, setAgentMode] = useState<AgentMode>();
  const [lastChecked, setLastChecked] = useState<Date>();

  const check = useCallback(async () => {
    try {
      const health = await api.health();
      setState("online");
      setAgentMode(health.agent_mode);
      setLastChecked(new Date());
      return true;
    } catch {
      setState("offline");
      setAgentMode(undefined);
      setLastChecked(new Date());
      return false;
    }
  }, []);

  useEffect(() => {
    void check();
    const interval = window.setInterval(() => void check(), 20_000);
    return () => window.clearInterval(interval);
  }, [check]);

  const value = useMemo(
    () => ({ state, agentMode, lastChecked, check }),
    [state, agentMode, lastChecked, check],
  );

  return <ApiStatusContext.Provider value={value}>{children}</ApiStatusContext.Provider>;
}

export function useApiStatus(): ApiStatusContextValue {
  const value = useContext(ApiStatusContext);
  if (!value) throw new Error("useApiStatus must be used within Providers");
  return value;
}
