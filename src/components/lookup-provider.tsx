import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useApiKey } from "@/components/api-key-provider";
import { cleanDomain } from "@/lib/utils";
import type { WhoisResult } from "@/lib/whois/types";

type LookupState = {
  target: string;
  apiKey: string;
  loading: boolean;
  data?: WhoisResult;
};

const LookupContext = createContext<{
  state: LookupState | null;
  lookup: (query: string) => Promise<void>;
} | null>(null);

export function LookupProvider({ children }: { children: React.ReactNode }) {
  const { apiKey, ready, request } = useApiKey();
  const [state, setState] = useState<LookupState | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    setState(null);
    return () => pending.current?.abort();
  }, [apiKey]);

  const lookup = useCallback(
    async (query: string) => {
      if (!ready) return;
      const target = cleanDomain(query.trim());
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setState({ target, apiKey, loading: true });

      try {
        const response = await request(
          `/api/lookup?query=${encodeURIComponent(target)}`,
          {
            signal: controller.signal,
          },
        );
        if (response.status === 401) throw new Error("Error 401");
        const data: WhoisResult = await response.json();
        if (!response.ok && !data.error)
          throw new Error(`Error ${response.status}`);
        if (!controller.signal.aborted)
          setState({ target, apiKey, loading: false, data });
      } catch (error) {
        if (!controller.signal.aborted) {
          setState({
            target,
            apiKey,
            loading: false,
            data: {
              status: false,
              time: -1,
              error: error instanceof Error ? error.message : "Lookup failed",
            },
          });
        }
      }
    },
    [apiKey, ready, request],
  );

  return (
    <LookupContext.Provider
      value={{ state: state?.apiKey === apiKey ? state : null, lookup }}
    >
      {children}
    </LookupContext.Provider>
  );
}

export function useLookup() {
  const context = useContext(LookupContext);
  if (!context) throw new Error("useLookup requires LookupProvider");
  return context;
}
