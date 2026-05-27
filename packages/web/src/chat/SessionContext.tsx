/**
 * SessionContext.tsx — session state lifted above the tab switcher (E2E-D04).
 *
 * Mounting SessionProvider above ChatTab in App.tsx ensures that
 * activeSessionId and inProgress survive Chat ↔ History tab switches,
 * which would otherwise unmount ChatTab and lose local component state.
 */

import { createContext, useContext, useState, type ReactNode } from "react";

interface SessionState {
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  inProgress: boolean;
  setInProgress: (v: boolean) => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [inProgress, setInProgress] = useState(false);
  return (
    <SessionContext.Provider value={{ activeSessionId, setActiveSessionId, inProgress, setInProgress }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const v = useContext(SessionContext);
  if (v === null) throw new Error("useSession: no <SessionProvider> in tree");
  return v;
}
