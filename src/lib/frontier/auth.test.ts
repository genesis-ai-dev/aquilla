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
        gitlab_token: "glpat-1",
        gitlab_url: "https://gitlab.example",
      }), { status: 200 })
    );
    const s = await login({ username: "alice", password: "pw" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.frontierrnd.com/api/v1/auth/token",
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

describe("FRONTIER_BASE env override", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses VITE_FRONTIER_BASE when set", async () => {
    vi.stubEnv("VITE_FRONTIER_BASE", "http://127.0.0.1:8787");
    vi.resetModules();
    const mod = await import("./auth");
    expect(mod.FRONTIER_BASE).toBe("http://127.0.0.1:8787");
  });

  it("falls back to api.frontierrnd.com when env is unset", async () => {
    vi.stubEnv("VITE_FRONTIER_BASE", "");
    vi.resetModules();
    const mod = await import("./auth");
    expect(mod.FRONTIER_BASE).toBe("https://api.frontierrnd.com");
  });
});
