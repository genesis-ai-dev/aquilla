import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { login, FrontierAuthError } from "./auth";
import { clearSession, loadSession } from "./session-store";

describe("login", () => {
  beforeEach(async () => { await clearSession(); vi.restoreAllMocks(); });

  it("posts credentials and persists session", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "jwt-1",
        token_type: "bearer",
      }), { status: 200 })
    );
    const s = await login({ username: "alice", password: "pw" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://aquilla-identity.blue-darkness-7674.workers.dev/api/v2/auth/token",
      expect.objectContaining({ method: "POST" })
    );
    expect(s.jwt).toBe("jwt-1");
    expect((await loadSession())?.jwt).toBe("jwt-1");
  });

  it("throws FrontierAuthError on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "bad creds" }), { status: 401 })
    );
    await expect(login({ username: "x", password: "y" })).rejects.toBeInstanceOf(FrontierAuthError);
  });
});

describe("AUTH_BASE env override", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses VITE_AUTH_BASE when set", async () => {
    vi.stubEnv("VITE_AUTH_BASE", "http://127.0.0.1:8787");
    vi.resetModules();
    const mod = await import("./auth");
    expect(mod.AUTH_BASE).toBe("http://127.0.0.1:8787");
  });

  it("falls back to aquilla-identity prod when env is unset", async () => {
    vi.stubEnv("VITE_AUTH_BASE", "");
    vi.resetModules();
    const mod = await import("./auth");
    expect(mod.AUTH_BASE).toBe(
      "https://aquilla-identity.blue-darkness-7674.workers.dev",
    );
  });
});
