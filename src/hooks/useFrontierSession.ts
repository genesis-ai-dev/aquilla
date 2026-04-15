import { useEffect, useState, useCallback } from "react";
import {
  loadSession, clearSession as clear, subscribeSession,
} from "@/lib/frontier/session-store";
import { login as doLogin } from "@/lib/frontier/auth";
import type { FrontierSession } from "@/lib/frontier/types";

export function useFrontierSession() {
  const [session, setSession] = useState<FrontierSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    function refresh() {
      loadSession().then((s) => { if (!cancelled) setSession(s); });
    }
    refresh();
    setLoading(false);
    const unsubscribe = subscribeSession(refresh);
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    return doLogin({ username, password }); // saveSession() inside notifies all hook instances
  }, []);

  const logout = useCallback(async () => {
    await clear();
  }, []);

  return { session, loading, login, logout };
}
