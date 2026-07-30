import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { login, redeemAccessLink, FrontierAuthError, AUTH_BASE } from "./auth";
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
      `${AUTH_BASE}/api/v2/auth/token`,
      expect.objectContaining({ method: "POST" })
    );
    expect(s.jwt).toBe("jwt-1");
    expect((await loadSession())?.jwt).toBe("jwt-1");
  });

  it("announces a confirmed migration before continuing login", async () => {
    const onMigrationRequired = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "migration_required" }), {
          status: 202,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          access_token: "jwt-migrated",
          token_type: "bearer",
        }), { status: 200 }),
      );

    const session = await login(
      { username: "legacy", password: "pw" },
      { onMigrationRequired },
    );

    expect(onMigrationRequired).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      username: "legacy",
      password: "pw",
      migration_handshake: true,
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({
      username: "legacy",
      password: "pw",
      migration_handshake: true,
      continue_migration: true,
    });
    expect(session.jwt).toBe("jwt-migrated");
  });

  it("throws FrontierAuthError on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "bad creds" }), { status: 401 })
    );
    await expect(login({ username: "x", password: "y" })).rejects.toBeInstanceOf(FrontierAuthError);
  });
});

describe("redeemAccessLink (AQU-626)", () => {
  beforeEach(async () => { await clearSession(); vi.restoreAllMocks(); });

  it("redeems a link+PIN, persists the bound session, and returns the project id", async () => {
    // payload: { sub: "translator", iat: 0, exp: 9999999999 }
    const payload = btoa(JSON.stringify({ sub: "translator", iat: 0, exp: 9999999999 }));
    const jwt = `h.${payload}.s`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: jwt,
        token_type: "bearer",
        username: "translator",
        project_id: "proj-9",
      }), { status: 200 })
    );
    const { session, projectId } = await redeemAccessLink("tok123", "4821");
    expect(fetchSpy).toHaveBeenCalledWith(
      `${AUTH_BASE}/api/v2/access-links/tok123/redeem`,
      expect.objectContaining({ method: "POST" })
    );
    expect(projectId).toBe("proj-9");
    expect(session.username).toBe("translator");
    // Session for the bound account is persisted, like a normal login.
    expect((await loadSession())?.jwt).toBe(jwt);
  });

  it("throws FrontierAuthError with the generic dead-link message on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "This link is invalid or has expired." }), { status: 401 })
    );
    await expect(redeemAccessLink("tok", "0000")).rejects.toMatchObject({
      status: 401,
      message: "This link is invalid or has expired.",
    });
    // No session written on failure.
    expect(await loadSession()).toBeNull();
  });
});

describe("login with email resolves canonical username from JWT sub", () => {
  beforeEach(async () => { await clearSession(); vi.restoreAllMocks(); });

  it("stores the username from JWT sub, not the email the user typed — AQU-134", async () => {
    // Simulate server returning a JWT whose `sub` is the canonical username
    // even though the client sent an email as the login identifier.
    // Header.Payload.Signature — payload: { "sub": "alice", "iat": 0, "exp": 9999999999 }
    const payload = btoa(JSON.stringify({ sub: "alice", iat: 0, exp: 9999999999 }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const fakeJwt = `header.${payload}.sig`;

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: fakeJwt, token_type: "bearer" }), { status: 200 })
    );

    // User logs in using their email address
    const session = await login({ username: "alice@example.com", password: "pw" });

    // The session username MUST be the canonical username from the JWT,
    // not the email the user typed. This is required so the admin view
    // (keyed by username) populates immediately without a relaunch.
    expect(session.username).toBe("alice");
    expect(session.username).not.toBe("alice@example.com");

    const stored = await (await import("./session-store")).loadSession();
    expect(stored?.username).toBe("alice");
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
    expect(mod.AUTH_BASE).toBe("https://api.aquilla.app/identity");
  });
});
