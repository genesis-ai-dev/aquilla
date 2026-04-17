import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { saveSession, loadSession, clearSession } from "./session-store";
import type { FrontierSession } from "./types";

const sample: FrontierSession = {
  jwt: "jwt-x",
  gitlabToken: "glpat-x",
  gitlabUrl: "https://gitlab.example",
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
    jwt: "jwt", gitlabToken: "g", gitlabUrl: "https://git.example.com",
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

  it("sessionKey dedupes by url + username", async () => {
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
