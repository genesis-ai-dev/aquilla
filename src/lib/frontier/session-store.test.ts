import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { saveSession, loadSession, clearSession } from "./session-store";
import type { FrontierSession } from "./types";

const sample: FrontierSession = {
  jwt: "jwt-x",
  username: "alice",
  createdAt: new Date().toISOString(),
};

describe("session-store", () => {
  beforeEach(async () => { await clearSession(); });

  it("returns null when nothing saved", async () => {
    expect(await loadSession()).toBeNull();
  });

  it("round-trips a session", async () => {
    await saveSession(sample);
    expect(await loadSession()).toEqual(sample);
  });

  it("clears", async () => {
    await saveSession(sample);
    await clearSession();
    expect(await loadSession()).toBeNull();
  });
});

import {
  listSessions, addSession, activateSession, removeSession,
  loadActiveSession, sessionKey,
} from "./session-store"

function mkSession(overrides: Partial<FrontierSession> = {}): FrontierSession {
  return {
    jwt: "jwt",
    username: "ryder", createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("multi-account envelope", () => {
  beforeEach(async () => {
    const { _resetDbForTesting } = await import("./session-store")
    await _resetDbForTesting()
  })

  it("addSession persists and activates the first session", async () => {
    const s = mkSession()
    await addSession(s)
    const list = await listSessions()
    expect(list).toHaveLength(1)
    expect(list[0].username).toBe("ryder")
    const active = await loadActiveSession()
    expect(active?.username).toBe("ryder")
  })

  it("addSession does not reactivate when an active session exists", async () => {
    const a = mkSession({ username: "ryder" })
    const b = mkSession({ username: "ada" })
    await addSession(a)
    await addSession(b)
    const active = await loadActiveSession()
    expect(active?.username).toBe("ryder")
  })

  it("activateSession switches the active pointer", async () => {
    await addSession(mkSession({ username: "ryder" }))
    await addSession(mkSession({ username: "ada" }))
    await activateSession(sessionKey(mkSession({ username: "ada" })))
    const active = await loadActiveSession()
    expect(active?.username).toBe("ada")
  })

  it("removeSession removes the session and picks next-active when removing active", async () => {
    await addSession(mkSession({ username: "ryder" }))
    await addSession(mkSession({ username: "ada" }))
    await removeSession(sessionKey(mkSession({ username: "ryder" })))
    const list = await listSessions()
    expect(list).toHaveLength(1)
    const active = await loadActiveSession()
    expect(active?.username).toBe("ada")
  })

  it("removeSession with only one session clears active", async () => {
    await addSession(mkSession({ username: "ryder" }))
    await removeSession(sessionKey(mkSession({ username: "ryder" })))
    const active = await loadActiveSession()
    expect(active).toBeNull()
  })

  it("sessionKey dedupes by username", async () => {
    const first = mkSession({ jwt: "old" })
    const second = mkSession({ jwt: "new" })
    await addSession(first)
    await addSession(second)
    const list = await listSessions()
    expect(list).toHaveLength(1)
    const active = await loadActiveSession()
    expect(active?.jwt).toBe("new")
  })
})

describe("migration from single-session to envelope", () => {
  it("migrates on first load when only the old `current` key exists", async () => {
    const { _resetDbForTesting, loadActiveSession, listSessions: list2 } = await import("./session-store")
    await _resetDbForTesting()
    const legacy = mkSession({ username: "legacy" })
    const { openDB } = await import("idb")
    const d = await openDB("frontier", 1, {
      upgrade(db) { if (!db.objectStoreNames.contains("session")) db.createObjectStore("session") },
    })
    await d.put("session", legacy, "current")
    d.close()

    const active = await loadActiveSession()
    expect(active?.username).toBe("legacy")
    const sessions = await list2()
    expect(sessions).toHaveLength(1)
  })
})

import { hasAuthHintCookie } from "./session-store"

describe("hasAuthHintCookie", () => {
  beforeEach(() => {
    document.cookie = "aq_hint=; Path=/; Max-Age=0"
  })

  it("returns false when aq_hint cookie is absent", () => {
    expect(hasAuthHintCookie()).toBe(false)
  })

  it("returns true when aq_hint=1 is present", () => {
    document.cookie = "aq_hint=1; Path=/"
    expect(hasAuthHintCookie()).toBe(true)
  })

  it("returns false when aq_hint has a value other than 1", () => {
    document.cookie = "aq_hint=0; Path=/"
    expect(hasAuthHintCookie()).toBe(false)
  })

  it("returns true when aq_hint=1 is among multiple cookies", () => {
    document.cookie = "other=abc; Path=/"
    document.cookie = "aq_hint=1; Path=/"
    expect(hasAuthHintCookie()).toBe(true)
  })
})

describe("aq_hint cookie", () => {
  beforeEach(async () => {
    const { _resetDbForTesting } = await import("./session-store")
    await _resetDbForTesting()
    // Also clear any residual cookie
    document.cookie = "aq_hint=; Path=/; Max-Age=0"
  })

  function getHint(): string | null {
    const match = document.cookie.match(/(?:^|;\s*)aq_hint=([^;]*)/)
    return match && match[1] !== "" ? match[1] : null
  }

  it("sets aq_hint=1 after saveSession", async () => {
    const { saveSession } = await import("./session-store")
    await saveSession({ jwt: "tok", username: "alice", createdAt: "2026-01-01T00:00:00Z" })
    expect(getHint()).toBe("1")
  })

  it("clears aq_hint after clearSession", async () => {
    const { saveSession, clearSession } = await import("./session-store")
    await saveSession({ jwt: "tok", username: "alice", createdAt: "2026-01-01T00:00:00Z" })
    expect(getHint()).toBe("1")
    await clearSession()
    expect(getHint()).toBeNull()
  })

  it("keeps aq_hint=1 when switching between two active sessions", async () => {
    const { addSession, activateSession, sessionKey } = await import("./session-store")
    const a = { jwt: "tok-a", username: "alice", createdAt: "2026-01-01T00:00:00Z" }
    const b = { jwt: "tok-b", username: "bob",   createdAt: "2026-01-01T00:00:00Z" }
    await addSession(a)
    await addSession(b)
    await activateSession(sessionKey(b))
    expect(getHint()).toBe("1")
  })
})
