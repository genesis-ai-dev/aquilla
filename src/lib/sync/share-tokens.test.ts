import { describe, it, expect, beforeEach } from "vitest"
import {
  generateToken, generatePin, hashPin, verifyPin,
  createShare, listShares, getShare, deleteShare,
} from "./share-tokens"
import { createProject, _resetDbForTesting } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "test-" + Math.random().toString(36).slice(2),
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  }
}

beforeEach(async () => {
  await _resetDbForTesting()
  const dbs = await indexedDB.databases()
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name)
  }
})

describe("generateToken", () => {
  it("produces an 8-char URL-safe string", () => {
    const t = generateToken()
    expect(t).toHaveLength(8)
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("produces different tokens each call", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()))
    expect(tokens.size).toBe(100)
  })
})

describe("generatePin", () => {
  it("produces a 6-digit numeric string", () => {
    const pin = generatePin()
    expect(pin).toHaveLength(6)
    expect(pin).toMatch(/^\d+$/)
  })

  it("produces different pins each call", () => {
    const pins = new Set(Array.from({ length: 50 }, () => generatePin()))
    // Not guaranteed all unique but extremely likely
    expect(pins.size).toBeGreaterThan(40)
  })
})

describe("hashPin + verifyPin", () => {
  it("hash is deterministic per (pin, token) pair", async () => {
    const a = await hashPin("123456", "tok12345")
    const b = await hashPin("123456", "tok12345")
    expect(a).toBe(b)
  })

  it("hash changes with token (salt)", async () => {
    const a = await hashPin("123456", "tok12345")
    const b = await hashPin("123456", "tok67890")
    expect(a).not.toBe(b)
  })

  it("hash changes with pin", async () => {
    const a = await hashPin("123456", "tok12345")
    const b = await hashPin("654321", "tok12345")
    expect(a).not.toBe(b)
  })

  it("verifyPin returns true for matching pin", async () => {
    const hash = await hashPin("123456", "tok12345")
    expect(await verifyPin("123456", "tok12345", hash)).toBe(true)
  })

  it("verifyPin returns false for wrong pin", async () => {
    const hash = await hashPin("123456", "tok12345")
    expect(await verifyPin("654321", "tok12345", hash)).toBe(false)
  })
})

describe("share CRUD", () => {
  it("creates a share without PIN", async () => {
    const project = makeProject({ id: "p1" })
    await createProject(project)
    const invite = await createShare("p1", undefined, "alice")
    expect(invite.token).toHaveLength(8)
    expect(invite.projectId).toBe("p1")
    expect(invite.pinHash).toBeUndefined()
    expect(invite.createdBy).toBe("alice")
  })

  it("creates a share with PIN", async () => {
    await createProject(makeProject({ id: "p1" }))
    const invite = await createShare("p1", "123456", "alice")
    expect(invite.pinHash).toBeDefined()
    expect(invite.pinHash).not.toBe("123456")
  })

  it("lists shares per project", async () => {
    await createProject(makeProject({ id: "p1" }))
    await createProject(makeProject({ id: "p2" }))
    await createShare("p1", undefined, "alice")
    await createShare("p1", undefined, "alice")
    await createShare("p2", undefined, "alice")

    const p1Shares = await listShares("p1")
    expect(p1Shares).toHaveLength(2)
    const p2Shares = await listShares("p2")
    expect(p2Shares).toHaveLength(1)
  })

  it("getShare by token", async () => {
    await createProject(makeProject({ id: "p1" }))
    const invite = await createShare("p1", undefined, "alice")
    const fetched = await getShare(invite.token)
    expect(fetched).toBeDefined()
    expect(fetched!.token).toBe(invite.token)
  })

  it("deletes a share", async () => {
    await createProject(makeProject({ id: "p1" }))
    const invite = await createShare("p1", undefined, "alice")
    await deleteShare(invite.token)
    expect(await getShare(invite.token)).toBeUndefined()
  })
})
