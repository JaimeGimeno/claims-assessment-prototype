import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { getRole, setRole as saveRole } from "./api";
import type { Reference, Role, Usage } from "./api";

interface AppData {
  reference: Reference;
  usage: Usage | null;
  refreshUsage: () => void;
  /** Which of the two people the visitor is viewing as. */
  role: Role;
  setRole: (r: Role) => void;
  name: (list: "parts" | "damage_types" | "severities" | "vehicle_classes" | "edit_reasons" | "operations" | "models", id: string | null | undefined) => string;
}

const Ctx = createContext<AppData | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("AppProvider is missing");
  return v;
}

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: (error: string | null, retry: () => void) => ReactNode }) {
  const [reference, setReference] = useState<Reference | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [role, setRoleState] = useState<Role>(getRole);
  const setRole = useCallback((r: Role) => {
    saveRole(r);
    setRoleState(r);
  }, []);

  const refreshUsage = useCallback(() => {
    api.usage().then(setUsage).catch(() => undefined);
  }, []);

  useEffect(() => {
    setError(null);
    api.reference().then(setReference).catch((e: Error) => setError(e.message));
    refreshUsage();
  }, [tick, refreshUsage]);

  const name = useCallback<AppData["name"]>(
    (list, id) => {
      if (!id) return "";
      const found = reference?.[list]?.find((x) => x.id === id);
      return found ? found.name : id.replace(/_/g, " ");
    },
    [reference],
  );

  if (!reference) return <>{fallback(error, () => setTick((t) => t + 1))}</>;
  return <Ctx.Provider value={{ reference, usage, refreshUsage, role, setRole, name }}>{children}</Ctx.Provider>;
}
