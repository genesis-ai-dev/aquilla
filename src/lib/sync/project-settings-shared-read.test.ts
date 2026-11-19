// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as restClient from "./project-settings"
import {
  MOUNT_REUSE_MS,
  readProjectSettingsShared,
  sameProjectSettingsResponse,
} from "./project-settings-shared-read"
import { noteProjectSettingsWrite } from "./project-settings-write-signal"

const row = (version = 1): restClient.ProjectSettingsResponse => ({
  version,
  updatedAt: `2026-11-19T00:00:0${version}Z`,
  updatedBy: null,
  settings: { validationCount: version },
})

type Read = restClient.FetchProjectSettingsResult

function deferredRead() {
  let resolve!: (value: Read) => void
  const promise = new Promise<Read>((res) => { resolve = res })
  return { promise, resolve }
}

/** Let the current synchronous turn end, as an awaited response would. */
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-19T12:00:00Z"))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("readProjectSettingsShared (AQU-2654)", () => {
  it("every reader of one row shares the request in flight", async () => {
    const pending = deferredRead()
    const fetchSpy = vi.spyOn(restClient, "fetchProjectSettingsResult").mockReturnValue(pending.promise)
    const reads = [
      readProjectSettingsShared("jwt", "p1", "mount"),
      readProjectSettingsShared("jwt", "p1", "revalidate"),
      readProjectSettingsShared("jwt", "p1", "mount"),
    ]
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const answer: Read = { ok: true, value: row() }
    pending.resolve(answer)
    // The same object for all of them: they resume together, in one commit.
    for (const result of await Promise.all(reads)) expect(result).toBe(answer)
  })

  it("keeps identities and projects apart", async () => {
    const fetchSpy = vi.spyOn(restClient, "fetchProjectSettingsResult").mockResolvedValue({ ok: true, value: row() })
    await Promise.all([
      readProjectSettingsShared("jwt-a", "p1", "mount"),
      readProjectSettingsShared("jwt-b", "p1", "mount"),
      readProjectSettingsShared("jwt-a", "p2", "mount"),
    ])
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it("a read that follows a write is not answered by a request that started before it", async () => {
    const before = deferredRead()
    const fetchSpy = vi.spyOn(restClient, "fetchProjectSettingsResult")
      .mockReturnValueOnce(before.promise)
      .mockResolvedValue({ ok: true, value: row(2) })
    const catchingUp = readProjectSettingsShared("jwt", "p1", "revalidate")
    await nextTurn()
    // The write lands; the event reaches two sibling instances in one dispatch.
    const siblingA = readProjectSettingsShared("jwt", "p1", "afterWrite")
    const siblingB = readProjectSettingsShared("jwt", "p1", "afterWrite")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect((await siblingA)).toEqual({ ok: true, value: row(2) })
    expect(await siblingB).toBe(await siblingA)
    // A reader arriving now joins nothing stale either: the old request is no
    // longer the one in flight for this row.
    before.resolve({ ok: true, value: row(1) })
    expect(await catchingUp).toEqual({ ok: true, value: row(1) })
    expect(await readProjectSettingsShared("jwt", "p1", "mount")).toEqual({ ok: true, value: row(2) })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("a mount is hydrated from an answer confirmed moments ago; a revalidation never is", async () => {
    const fetchSpy = vi.spyOn(restClient, "fetchProjectSettingsResult").mockResolvedValue({ ok: true, value: row() })
    await readProjectSettingsShared("jwt", "p1", "mount")
    await readProjectSettingsShared("jwt", "p1", "mount")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // Coming back to the tab is a real read, whatever was read before it.
    await readProjectSettingsShared("jwt", "p1", "revalidate")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    vi.setSystemTime(Date.now() + MOUNT_REUSE_MS)
    await readProjectSettingsShared("jwt", "p1", "mount")
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it("an answer read before a write never hydrates a mount after it", async () => {
    const fetchSpy = vi.spyOn(restClient, "fetchProjectSettingsResult").mockResolvedValue({ ok: true, value: row(1) })
    await readProjectSettingsShared("jwt", "p1", "mount")
    noteProjectSettingsWrite("p1")
    fetchSpy.mockResolvedValue({ ok: true, value: row(2) })
    expect(await readProjectSettingsShared("jwt", "p1", "mount")).toEqual({ ok: true, value: row(2) })
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    // Nor does a read that was in flight while the write happened.
    const across = deferredRead()
    fetchSpy.mockReturnValueOnce(across.promise)
    vi.setSystemTime(Date.now() + MOUNT_REUSE_MS)
    const inFlight = readProjectSettingsShared("jwt", "p1", "mount")
    noteProjectSettingsWrite("p1")
    across.resolve({ ok: true, value: row(2) })
    await inFlight
    fetchSpy.mockResolvedValue({ ok: true, value: row(3) })
    expect(await readProjectSettingsShared("jwt", "p1", "mount")).toEqual({ ok: true, value: row(3) })
  })

  it("a failed read is not kept", async () => {
    const fetchSpy = vi.spyOn(restClient, "fetchProjectSettingsResult")
      .mockResolvedValueOnce({ ok: false, status: 503, message: "unavailable" })
      .mockResolvedValue({ ok: true, value: row() })
    expect((await readProjectSettingsShared("jwt", "p1", "mount")).ok).toBe(false)
    expect((await readProjectSettingsShared("jwt", "p1", "mount")).ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe("sameProjectSettingsResponse", () => {
  it("is true for equal content in different objects, false when anything moved", () => {
    expect(sameProjectSettingsResponse(row(1), row(1))).toBe(true)
    expect(sameProjectSettingsResponse(row(1), row(2))).toBe(false)
    expect(sameProjectSettingsResponse(row(1), { ...row(1), lanes: [] })).toBe(false)
    expect(sameProjectSettingsResponse(null, null)).toBe(true)
    expect(sameProjectSettingsResponse(row(1), null)).toBe(false)
  })
})
