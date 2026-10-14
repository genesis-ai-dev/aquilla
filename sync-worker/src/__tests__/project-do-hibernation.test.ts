import { describe, expect, it } from "vitest"
import {
  ALARM_MIN_DELAY_MS,
  AUTO_RESPONSE_PING_FRAME,
  AUTO_RESPONSE_PONG_FRAME,
  CONNECTION_ATTACHMENT_VERSION,
  foldAutoResponse,
  nextSweepDeadlineAt,
  parseConnectionAttachment,
  pruneDeniedUsers,
  shouldMoveAlarm,
  toConnectionAttachment,
} from "../project-do-hibernation"
import { PRESENCE_HEARTBEAT_TTL_MS, type LockState, type PresenceState } from "../project-do-handlers"

const NOW = 1_800_000_000_000

function conn(over: Partial<Parameters<typeof toConnectionAttachment>[0]> = {}) {
  return {
    projectId: "proj-1",
    connId: "conn-aaaaaaaa",
    userId: "ryder",
    numericUserId: 7,
    role: 30,
    tokenExpiresAt: NOW + 60_000,
    lastSeenAt: NOW,
    heartbeatSeen: true,
    ...over,
  }
}

// ── Attachment round-trip ────────────────────────────────────────────────
// The attachment is the ONLY record of a connection's identity once the DO is
// evicted, so what survives it is load-bearing for presence, locks and the
// role gate on focus.claim.

describe("connection attachment", () => {
  it("round-trips identity and the presence row", () => {
    const presence: PresenceState = {
      connId: "conn-aaaaaaaa",
      userId: "ryder",
      focusedCell: "GEN 1:1",
      viewingCell: "GEN 1:1",
      currentFileId: "file-1",
      ts: NOW,
    }
    const restored = parseConnectionAttachment(toConnectionAttachment(conn(), presence))
    expect(restored).toEqual({
      v: CONNECTION_ATTACHMENT_VERSION,
      projectId: "proj-1",
      connId: "conn-aaaaaaaa",
      userId: "ryder",
      numericUserId: 7,
      role: 30,
      tokenExpiresAt: NOW + 60_000,
      lastSeenAt: NOW,
      heartbeatSeen: true,
      presence,
    })
  })

  it("never carries live draft text (2 KiB attachment ceiling)", () => {
    const presence: PresenceState = {
      connId: "conn-aaaaaaaa",
      userId: "ryder",
      focusedCell: "GEN 1:1",
      selection: { side: "target", anchor: 0, head: 4, draftText: "x".repeat(4_000) },
      ts: NOW,
    }
    const attachment = toConnectionAttachment(conn(), presence)
    expect(attachment.presence.selection).toEqual({ side: "target", anchor: 0, head: 4 })
    expect(JSON.stringify(attachment).length).toBeLessThan(2_048)
  })

  it("synthesises a presence row when the connection has none yet", () => {
    const attachment = toConnectionAttachment(conn(), undefined)
    expect(attachment.presence).toEqual({ connId: "conn-aaaaaaaa", userId: "ryder", ts: NOW })
  })

  it("rejects anything it cannot trust as an identity", () => {
    expect(parseConnectionAttachment(null)).toBeNull()
    expect(parseConnectionAttachment("conn-aaaaaaaa")).toBeNull()
    // A socket accepted by an older deploy: no version tag.
    expect(parseConnectionAttachment({ connId: "c", userId: "u", lastSeenAt: NOW })).toBeNull()
    expect(parseConnectionAttachment({ ...toConnectionAttachment(conn(), undefined), v: 99 })).toBeNull()
    expect(parseConnectionAttachment({ ...toConnectionAttachment(conn(), undefined), userId: 7 })).toBeNull()
    // AQU-1839: without the project a token.refresh after a wake could not be
    // re-verified against anything — retire the socket rather than guess.
    const { projectId: _noProject, ...withoutProject } = toConnectionAttachment(conn(), undefined)
    expect(parseConnectionAttachment(withoutProject)).toBeNull()
  })

  it("re-stamps the presence row's identity from the attachment's", () => {
    const attachment = toConnectionAttachment(conn(), undefined)
    const tampered = { ...attachment, presence: { ...attachment.presence, connId: "someone-else", userId: "mallory" } }
    expect(parseConnectionAttachment(tampered)?.presence).toMatchObject({
      connId: "conn-aaaaaaaa",
      userId: "ryder",
    })
  })

  it("tolerates a missing presence row rather than dropping the connection", () => {
    const { presence: _dropped, ...withoutPresence } = toConnectionAttachment(conn(), undefined)
    const restored = parseConnectionAttachment(withoutPresence)
    expect(restored?.presence).toEqual({ connId: "conn-aaaaaaaa", userId: "ryder", ts: NOW })
  })
})

// ── Auto-response folding ────────────────────────────────────────────────

describe("foldAutoResponse", () => {
  it("treats a runtime-answered ping as liveness the DO never saw", () => {
    const seen = foldAutoResponse({ lastSeenAt: NOW, heartbeatSeen: false }, new Date(NOW + 50_000))
    expect(seen).toEqual({ lastSeenAt: NOW + 50_000, heartbeatSeen: true })
  })

  it("keeps the newer of the two timestamps", () => {
    const seen = foldAutoResponse({ lastSeenAt: NOW + 10, heartbeatSeen: true }, new Date(NOW))
    expect(seen.lastSeenAt).toBe(NOW + 10)
  })

  it("leaves a client that has never been auto-responded untouched", () => {
    // AQU-1791: a client that never pings must stay out of the stale sweep.
    expect(foldAutoResponse({ lastSeenAt: NOW, heartbeatSeen: false }, null)).toEqual({
      lastSeenAt: NOW,
      heartbeatSeen: false,
    })
  })

  it("pairs a ping frame with the pong the client recognises", () => {
    expect(JSON.parse(AUTO_RESPONSE_PING_FRAME)).toEqual({ t: "ping" })
    expect(JSON.parse(AUTO_RESPONSE_PONG_FRAME)).toEqual({ t: "pong" })
  })
})

// ── Alarm scheduling ─────────────────────────────────────────────────────

describe("nextSweepDeadlineAt", () => {
  const lock = (expiresAt: number): LockState => ({ cellId: "GEN 1:1", userId: "ryder", expiresAt })
  const socket = (over: Partial<{ tokenExpiresAt: number | null; lastSeenAt: number; heartbeatSeen: boolean }> = {}) => ({
    tokenExpiresAt: null,
    lastSeenAt: NOW,
    heartbeatSeen: false,
    ...over,
  })

  it("arms nothing when there is nothing to sweep", () => {
    expect(nextSweepDeadlineAt({ now: NOW, locks: [], connections: [] })).toBeNull()
    // A dev socket with no token and no heartbeat has no deadline either —
    // this is the case that lets an untouched DO hibernate outright.
    expect(nextSweepDeadlineAt({ now: NOW, locks: [], connections: [socket()] })).toBeNull()
  })

  it("arms for the earliest lease expiry", () => {
    expect(
      nextSweepDeadlineAt({ now: NOW, locks: [lock(NOW + 30_000), lock(NOW + 12_000)], connections: [] }),
    ).toBe(NOW + 12_000)
  })

  it("arms for a token expiry ahead of a later lease", () => {
    expect(
      nextSweepDeadlineAt({
        now: NOW,
        locks: [lock(NOW + 30_000)],
        connections: [socket({ tokenExpiresAt: NOW + 9_000 })],
      }),
    ).toBe(NOW + 9_000)
  })

  it("arms one heartbeat TTL after the quietest heartbeating socket", () => {
    expect(
      nextSweepDeadlineAt({
        now: NOW,
        locks: [],
        connections: [socket({ heartbeatSeen: true, lastSeenAt: NOW - 1_000 })],
      }),
    ).toBe(NOW - 1_000 + PRESENCE_HEARTBEAT_TTL_MS)
  })

  it("never arms tighter than the floor, however overdue the deadline", () => {
    expect(nextSweepDeadlineAt({ now: NOW, locks: [lock(NOW - 60_000)], connections: [] })).toBe(
      NOW + ALARM_MIN_DELAY_MS,
    )
  })
})

describe("shouldMoveAlarm", () => {
  it("arms when nothing is armed", () => {
    expect(shouldMoveAlarm(null, NOW + 1_000)).toBe(true)
  })

  it("leaves an alarm that fires early — the sweep just re-arms", () => {
    expect(shouldMoveAlarm(NOW + 1_000, NOW + 60_000)).toBe(false)
  })

  it("moves an alarm that would fire materially too late", () => {
    expect(shouldMoveAlarm(NOW + 60_000, NOW + 1_000)).toBe(true)
  })

  it("ignores sub-slack differences so storage is not churned", () => {
    expect(shouldMoveAlarm(NOW + 1_500, NOW + 1_000)).toBe(false)
  })
})

// ── Membership denylist ──────────────────────────────────────────────────

describe("pruneDeniedUsers", () => {
  it("keeps entries whose deny window is still open", () => {
    const { entries, changed } = pruneDeniedUsers({ "7": NOW + 60_000 }, NOW)
    expect(entries).toEqual({ "7": NOW + 60_000 })
    expect(changed).toBe(false)
  })

  it("drops entries at or past their deadline", () => {
    const { entries, changed } = pruneDeniedUsers({ "7": NOW, "9": NOW + 1 }, NOW)
    expect(entries).toEqual({ "9": NOW + 1 })
    expect(changed).toBe(true)
  })

  it("drops a corrupt entry instead of trusting it forever", () => {
    const { entries, changed } = pruneDeniedUsers({ "7": "soon" as unknown as number }, NOW)
    expect(entries).toEqual({})
    expect(changed).toBe(true)
  })
})
