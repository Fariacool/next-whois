import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { API_KEY_STORAGE_KEY, requestApi } from "@/lib/api-client";

type ApiKeyContextValue = {
  apiKey: string;
  ready: boolean;
  saveApiKey: (key: string) => void;
  clearApiKey: () => void;
  request: (path: string, init?: RequestInit) => Promise<Response>;
};

const ApiKeyContext = createContext<ApiKeyContextValue | null>(null);

export function ApiKeyProvider({ children }: { children: React.ReactNode }) {
  const [apiKey, setApiKey] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setApiKey(localStorage.getItem(API_KEY_STORAGE_KEY) || "");
    } catch {
      setApiKey("");
    } finally {
      setReady(true);
    }

    const syncKey = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === API_KEY_STORAGE_KEY || event.key === null)
      ) {
        setApiKey(event.newValue || "");
      }
    };
    window.addEventListener("storage", syncKey);
    return () => window.removeEventListener("storage", syncKey);
  }, []);

  const saveApiKey = useCallback((key: string) => {
    const value = key.trim();
    localStorage.setItem(API_KEY_STORAGE_KEY, value);
    setApiKey(value);
  }, []);

  const clearApiKey = useCallback(() => {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    setApiKey("");
  }, []);

  const request = useCallback(
    (path: string, init?: RequestInit) => requestApi(path, apiKey, init),
    [apiKey],
  );

  return (
    <ApiKeyContext.Provider
      value={{ apiKey, ready, saveApiKey, clearApiKey, request }}
    >
      {children}
    </ApiKeyContext.Provider>
  );
}

export function useApiKey() {
  const context = useContext(ApiKeyContext);
  if (!context) throw new Error("useApiKey requires ApiKeyProvider");
  return context;
}
