import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  login,
  register,
  redeemAccessLink,
  requestPasswordReset,
  verifyResetToken,
  verifyEmail,
  resetPassword,
  FrontierAuthError,
  AUTH_BASE,
} from "./auth";
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
      )
      // finalizeSession falls back to GET /auth/me for the address whenever the
      // minted JWT carries no `email` claim, as it does for these legacy tokens.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ email: "legacy@example.com" }), {
          status: 200,
        }),
      );

    const session = await login(
      { username: "legacy", password: "pw" },
      { onMigrationRequired },
    );

    expect(onMigrationRequired).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
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
    expect(fetchSpy.mock.calls[2]?.[0]).toBe(`${AUTH_BASE}/api/v2/auth/me`);
    expect(session.jwt).toBe("jwt-migrated");
    expect(session.email).toBe("legacy@example.com");
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

  // AQU-820 regression: the server used to be able to put arbitrary text in
  // front of the user by varying its `error` body — which both bypassed i18n
  // (raw, unlocalized English) and broke the "every failure looks the same"
  // no-oracle guarantee this flow depends on. Assert our fixed, keyed message
  // wins even when the server sends something completely different.
  it("never surfaces server-supplied body text, even if the server varies it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "PIN incorrect for this link" }), { status: 401 })
    );
    await expect(redeemAccessLink("tok", "0000")).rejects.toMatchObject({
      status: 401,
      message: "This link is invalid or has expired.",
    });
  });

  it("uses a fixed, translated message for a fetch-level failure (server unreachable)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(redeemAccessLink("tok", "0000")).rejects.toMatchObject({
      status: 0,
      message: "Couldn't reach the server. Check your connection and try again.",
    });
  });
  // ^ reuses auth.join.networkError's English text (see no-duplicates guard).
});

// AQU-820: register/reset/verify used to lift `body.error` / `body.detail`
// straight from the server response and throw it verbatim — raw, unlocalized
// English regardless of the active UI locale, unlike login() (above), which
// has always thrown its own fixed messages. These assert the raw server body
// text no longer wins.
describe("register — AQU-820 (server detail composed into a translated frame)", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("weaves a validation/conflict detail into our own sentence, not verbatim", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "username already taken" }), { status: 409 })
    );
    await expect(
      register({ username: "bob", email: "bob@example.com", password: "pw123456" }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Couldn't create your account: username already taken",
    });
  });

  it("falls back to a fully generic translated message when the server gives no detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    await expect(
      register({ username: "bob", email: "bob@example.com", password: "pw123456" }),
    ).rejects.toMatchObject({
      status: 500,
      message: "Couldn't create your account. Please try again.",
    });
  });
});

describe("password reset + verify-email — AQU-820 (no raw server body)", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("requestPasswordReset drops server body.error/detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "no such account on file" }), { status: 404 })
    );
    await expect(requestPasswordReset("nobody@example.com")).rejects.toMatchObject({
      message: "Failed to send reset email",
    });
  });

  it("verifyResetToken drops server body.error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Token expired" }), { status: 400 })
    );
    await expect(verifyResetToken("tok", "alice")).rejects.toMatchObject({
      message: "This reset link is no longer valid. Please request a new one.",
    });
  });

  it("verifyEmail drops server body.error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "already used" }), { status: 404 })
    );
    await expect(verifyEmail("tok")).rejects.toMatchObject({
      message: "Verification failed.",
    });
  });

  it("resetPassword maps a 400 to the token-invalid message, not the raw body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid token" }), { status: 400 })
    );
    await expect(resetPassword("tok", "alice", "NewSecret99!")).rejects.toMatchObject({
      message: "This reset link is no longer valid. Please request a new one.",
    });
  });

  it("resetPassword maps a 500 to the generic reset-failed message, not the raw body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Failed to reset password" }), { status: 500 })
    );
    await expect(resetPassword("tok", "alice", "NewSecret99!")).rejects.toMatchObject({
      message: "Failed to reset password",
    });
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

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return new Response(JSON.stringify({
          id: 1, username: "alice", email: "alice@example.com", preferences: {},
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: fakeJwt, token_type: "bearer" }), { status: 200 });
    });

    // User logs in using their email address
    const session = await login({ username: "alice@example.com", password: "pw" });

    // The session username MUST be the canonical username from the JWT,
    // not the email the user typed. This is required so the admin view
    // (keyed by username) populates immediately without a relaunch.
    expect(session.username).toBe("alice");
    expect(session.username).not.toBe("alice@example.com");
    expect(session.email).toBe("alice@example.com");

    const stored = await (await import("./session-store")).loadSession();
    expect(stored?.username).toBe("alice");
    expect(stored?.email).toBe("alice@example.com");
  });
});

describe("hydrateSessionEmails", () => {
  beforeEach(async () => {
    const { _resetDbForTesting } = await import("./session-store");
    await _resetDbForTesting();
    vi.restoreAllMocks();
  });

  it("backfills email onto every stored account missing it", async () => {
    const { addSession, listSessions } = await import("./session-store");
    const { hydrateSessionEmails } = await import("./auth");

    await addSession({ jwt: "jwt-a", username: "keeandev", createdAt: "2026-01-01T00:00:00Z" });
    await addSession({ jwt: "jwt-b", username: "Keean", createdAt: "2026-01-01T00:00:00Z" });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      const auth = headers.get("Authorization") ?? "";
      const email = auth.includes("jwt-a") ? "keeandev@example.com" : "keean@example.com";
      return new Response(JSON.stringify({
        id: 1, username: "x", email, preferences: {},
      }), { status: 200 });
    });

    await hydrateSessionEmails();
    const list = await listSessions();
    const byUser = Object.fromEntries(list.map((s) => [s.username, s.email]));
    expect(byUser.keeandev).toBe("keeandev@example.com");
    expect(byUser.Keean).toBe("keean@example.com");
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
