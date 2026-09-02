import { describe, it, expect, beforeEach, vi } from "vitest";
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
  loadActiveSession, sessionKey, subscribeSession, patchSessionEmails,
  loadAccountsSnapshot, publishDataOwner, listStoredSessions,
  isStoredSessionCurrent,
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

  it("saveSession for an added account preserves the existing account and activates the new one", async () => {
    await saveSession(mkSession({ username: "alice", jwt: "alice-jwt" }))
    await saveSession(mkSession({ username: "bob", jwt: "bob-jwt" }))

    expect((await listSessions()).map((s) => s.username).sort()).toEqual(["alice", "bob"])
    expect((await loadActiveSession())?.username).toBe("bob")
  })

  it("provides exact credential snapshots and rejects removed or rotated JWTs", async () => {
    await addSession(mkSession({ username: "alice", jwt: "alice-jwt-1" }))
    await addSession(mkSession({ username: "bob", jwt: "bob-jwt" }))

    expect((await listStoredSessions()).map(({ key, session }) => [key, session.jwt]).sort()).toEqual([
      ["alice", "alice-jwt-1"],
      ["bob", "bob-jwt"],
    ])
    expect(await isStoredSessionCurrent("alice", "alice-jwt-1")).toBe(true)

    await addSession(mkSession({ username: "alice", jwt: "alice-jwt-2" }))
    expect(await isStoredSessionCurrent("alice", "alice-jwt-1")).toBe(false)
    expect(await isStoredSessionCurrent("alice", "alice-jwt-2")).toBe(true)

    await removeSession("alice")
    expect(await isStoredSessionCurrent("alice", "alice-jwt-2")).toBe(false)
  })

  it("keeps the last published data owner until the matching transition completes", async () => {
    await saveSession(mkSession({ username: "alice", jwt: "alice-jwt" }))
    expect((await loadAccountsSnapshot()).dataOwner).toBeUndefined()
    expect(await publishDataOwner("alice")).toBe(true)

    await saveSession(mkSession({ username: "bob", jwt: "bob-jwt" }))
    const switching = await loadAccountsSnapshot()
    expect(switching.active?.username).toBe("bob")
    expect(switching.dataOwner).toBe("alice")
    expect(await publishDataOwner("alice")).toBe(false)
    expect(await publishDataOwner("bob")).toBe(true)
    expect((await loadAccountsSnapshot()).dataOwner).toBe("bob")
  })
})

describe("cross-tab mutation serialization", () => {
  it("preserves simultaneous account writes from independent module connections", async () => {
    const base = await import("./session-store")
    await base._resetDbForTesting()

    vi.resetModules()
    const tabA = await import("./session-store")
    vi.resetModules()
    const tabB = await import("./session-store")

    await Promise.all([
      tabA.addSession(mkSession({ username: "alice", jwt: "alice-jwt" })),
      tabB.addSession(mkSession({ username: "bob", jwt: "bob-jwt" })),
    ])

    expect((await tabB.listSessions()).map((s) => s.username).sort()).toEqual(["alice", "bob"])
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

  it("[Pen test 2026-08-17] writes Secure on an https origin, omits it on http", async () => {
    const { saveSession, clearSession } = await import("./session-store")
    const writes: string[] = []
    const spy = vi
      .spyOn(document, "cookie", "set")
      .mockImplementation((v: string) => {
        writes.push(v)
      })
    const originalProtocol = location.protocol

    try {
      Object.defineProperty(location, "protocol", { value: "https:", configurable: true })
      await saveSession({ jwt: "tok", username: "alice", createdAt: "2026-01-01T00:00:00Z" })
      expect(writes.some((w) => w.startsWith("aq_hint=1") && w.includes("Secure"))).toBe(true)

      writes.length = 0
      await clearSession()
      expect(writes.some((w) => w.startsWith("aq_hint=") && w.includes("Secure"))).toBe(true)

      writes.length = 0
      Object.defineProperty(location, "protocol", { value: "http:", configurable: true })
      await saveSession({ jwt: "tok", username: "alice", createdAt: "2026-01-01T00:00:00Z" })
      expect(writes.some((w) => w.startsWith("aq_hint=1") && !w.includes("Secure"))).toBe(true)
    } finally {
      spy.mockRestore()
      Object.defineProperty(location, "protocol", { value: originalProtocol, configurable: true })
    }
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

describe("cross-tab reconciliation (FRO-367)", () => {
  // This vitest/happy-dom env doesn't provide localStorage (the reason the
  // repo's org/localStorage suites are red), while the browser always does.
  // Install a minimal in-memory shim so the ping path is exercisable; the
  // source guards the real call in try/catch either way.
  let storageShimInstalled = false
  beforeEach(async () => {
    if (!storageShimInstalled && typeof globalThis.localStorage === "undefined") {
      const map = new Map<string, string>()
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
          setItem: (k: string, v: string) => { map.set(k, String(v)) },
          removeItem: (k: string) => { map.delete(k) },
          clear: () => { map.clear() },
          key: (i: number) => Array.from(map.keys())[i] ?? null,
          get length() { return map.size },
        },
      })
      storageShimInstalled = true
    }
    const { _resetDbForTesting } = await import("./session-store")
    await _resetDbForTesting()
    localStorage.clear()
  })

  it("bumps the session-ping localStorage key on every write with a distinct value", async () => {
    await addSession(mkSession({ username: "alice" }))
    const first = localStorage.getItem("frontier:session-ping")
    expect(first).not.toBeNull()

    await addSession(mkSession({ username: "bob" }))
    const second = localStorage.getItem("frontier:session-ping")
    expect(second).not.toBeNull()
    expect(second).not.toBe(first) // forces a `storage` event on every write
  })

  // Each mutation reads the envelope and writes it back as separate awaits, so
  // overlapping mutations must not interleave: the slower one would write back
  // a snapshot taken before the faster one landed and silently undo it. This
  // is the shape that broke logout in the browser — the email backfill runs
  // while the account menu is open, so a logout landing mid-backfill was
  // overwritten and the "logged out" account reappeared as active.
  it("overlapping mutations do not lose updates", async () => {
    const users = Array.from({ length: 12 }, (_, i) =>
      mkSession({ username: `u${i}`, jwt: `j${i}` }),
    )
    // Every one of these reads the envelope and writes it back. Unserialized,
    // they all read the same near-empty snapshot and the last write wins.
    await Promise.all(users.map(addSession))

    const list = await listSessions()
    expect(list.map((s) => s.username).sort()).toEqual(users.map((u) => u.username).sort())
  })

  it("an email backfill overlapping a removal leaves the removal intact", async () => {
    const alice = mkSession({ username: "alice", jwt: "a" })
    const bob = mkSession({ username: "bob", jwt: "b", createdAt: "2026-01-02T00:00:00Z" })
    await addSession(alice)
    await addSession(bob)

    // Interleave the backfill with other in-flight envelope writes, the way it
    // overlaps a logout in the browser: the menu is open, /auth/me is still
    // resolving, and the user clicks Log out.
    await Promise.all([
      patchSessionEmails({
        [sessionKey(alice)]: "alice@example.com",
        [sessionKey(bob)]: "bob@example.com",
      }),
      addSession(mkSession({ username: "carol", jwt: "c" })),
      removeSession(sessionKey(alice)),
    ])

    const list = await listSessions()
    expect(list.map((s) => s.username).sort()).toEqual(["bob", "carol"])
    expect(await loadActiveSession()).toMatchObject({ username: "bob" })
  })

  it("a session-ping storage event fires subscribers; other keys don't", async () => {
    const seen = vi.fn()
    const un = subscribeSession(seen)
    seen.mockClear() // subscribe itself doesn't fire

    window.dispatchEvent(new StorageEvent("storage", { key: "frontier:session-ping", newValue: "x" }))
    await Promise.resolve()
    expect(seen).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new StorageEvent("storage", { key: "some-other-key", newValue: "y" }))
    expect(seen).toHaveBeenCalledTimes(1) // unchanged

    un()
  })

  it("deduplicates BroadcastChannel and storage delivery and reconciles on focus", async () => {
    const OriginalBroadcastChannel = window.BroadcastChannel
    const channelHarness: { dispatch?: (ping: string) => void } = {}
    class FakeBroadcastChannel {
      private listener: ((event: MessageEvent<string>) => void) | null = null
      constructor(_name: string) {
        channelHarness.dispatch = (ping) => this.dispatch(ping)
      }
      addEventListener(_type: string, listener: (event: MessageEvent<string>) => void) {
        this.listener = listener
      }
      postMessage() {}
      close() {}
      dispatch(ping: string) { this.listener?.(new MessageEvent("message", { data: ping })) }
    }

    Object.defineProperty(window, "BroadcastChannel", {
      configurable: true,
      value: FakeBroadcastChannel,
    })
    try {
      vi.resetModules()
      const isolated = await import("./session-store")
      const seen = vi.fn()
      const un = isolated.subscribeSession(seen)

      channelHarness.dispatch?.("same-ping")
      window.dispatchEvent(new StorageEvent("storage", {
        key: "frontier:session-ping",
        newValue: "same-ping",
      }))
      await Promise.resolve()
      expect(seen).toHaveBeenCalledTimes(1)

      window.dispatchEvent(new Event("focus"))
      await Promise.resolve()
      expect(seen).toHaveBeenCalledTimes(2)
      un()
    } finally {
      Object.defineProperty(window, "BroadcastChannel", {
        configurable: true,
        value: OriginalBroadcastChannel,
      })
    }
  })
})
