import { useEffect, useState, useCallback } from "react";
import { loadSession, clearSession as clear } from "@/lib/frontier/session-store";
import { login as doLogin } from "@/lib/frontier/auth";
import type { FrontierSession } from "@/lib/frontier/types";

export function useFrontierSession() {
  const [session, setSession] = useState<FrontierSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadSession().then((s) => {
      if (!cancelled) {
        setSession(s);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const s = await doLogin({ username, password });
    setSession(s);
    return s;
  }, []);

  const logout = useCallback(async () => {
    await clear();
    setSession(null);
  }, []);

  return { session, loading, login, logout };
}
