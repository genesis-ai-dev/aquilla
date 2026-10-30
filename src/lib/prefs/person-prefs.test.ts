// AQU-2264: the recorder's and the timeline's preferences follow the person.
//
// Two "devices" here are two browser storages for the same person, swapped in
// and out of happy-dom's one localStorage; the server is the in-memory stand-in
// for the identity worker's preference routes. What these pin:
//   - signed out, a preference stays on the device under its old key;
//   - signed in, an edit reaches the person's record, merged, and another
//     device takes it on its next read;
//   - the first device to sync gives the person its values; later ones adopt;
//   - an edit made offline is kept (across a reload) and lands once online;
//   - two people on one browser never see each other's values.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  resetClientLocalStorageOwnerForTests,
  setClientLocalStorageOwner,
} from "@/lib/frontier/client-local-storage"
import { createFakePreferencesServer, type FakePreferencesServer } from "@/test-utils/fake-preferences-server"
import {
  definePersonPref,
  flushPersonPrefs,
  PERSON_PREFS_FLUSH_DELAY_MS,
  refreshPersonPrefs,
  resetPersonPrefCachesForTests,
  resetPersonPrefsSyncForTests,
  setPersonPrefsSession,
} from "./person-prefs"
import {
  recorderCountdownBeepPref,
  recorderCountdownPref,
  recorderFilmAudiblePref,
  recorderFilmCollapsedPref,
  recorderFormatPref,
  recorderKeepTakesDrawerOpenPref,
  recorderMoveOnAfterSavingPref,
  timelineFollowPlayheadPref,
  timelineSnapPref,
} from "./person-pref-list"

const originalFetch = globalThis.fetch
let server: FakePreferencesServer
const devices = new Map<string, Record<string, string>>()
let currentDevice = "laptop"

/** Put this device's storage away and bring out another's (a different browser). */
function useDevice(name: string): void {
  const saved: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key) saved[key] = localStorage.getItem(key) ?? ""
  }
  devices.set(currentDevice, saved)
  localStorage.clear()
  for (const [key, value] of Object.entries(devices.get(name) ?? {})) localStorage.setItem(key, value)
  currentDevice = name
  // A different browser: nothing cached, no session yet.
  resetPersonPrefsSyncForTests()
  resetClientLocalStorageOwnerForTests()
}

/** Sign `username` in on this device, as the account boundary does. */
function signIn(username: string): void {
  setClientLocalStorageOwner(username)
  setPersonPrefsSession({ username, jwt: `jwt-${username}` })
}

function signOut(): void {
  setClientLocalStorageOwner(null)
  setPersonPrefsSession(null)
}

function setOnline(on: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => on })
}

const patches = () => server.calls.filter((c) => c.method === "PATCH")

beforeEach(() => {
  localStorage.clear()
  devices.clear()
  currentDevice = "laptop"
  resetPersonPrefsSyncForTests()
  resetClientLocalStorageOwnerForTests()
  server = createFakePreferencesServer({ commentEmails: "all" })
  globalThis.fetch = server.fetch
  setOnline(true)
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = originalFetch
  setOnline(true)
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

describe("signed out", () => {
  it("keeps the value on this device, under its old key, and calls no server", async () => {
    signOut()
    recorderCountdownPref.set("fast")
    timelineSnapPref.set(false)
    expect(localStorage.getItem("aq.recording-countdown.v1")).toBe("fast")
    expect(localStorage.getItem("aquilla:timelineSnap")).toBe("off")
    resetPersonPrefCachesForTests()
    expect(recorderCountdownPref.get()).toBe("fast")
    await flushPersonPrefs()
    expect(server.calls).toEqual([])
  })

  it("remembers the countdown beep and Follow playhead, which nothing kept before", () => {
    signOut()
    recorderCountdownBeepPref.set(false)
    timelineFollowPlayheadPref.set(false)
    resetPersonPrefCachesForTests() // a reload
    expect(recorderCountdownBeepPref.get()).toBe(false)
    expect(timelineFollowPlayheadPref.get()).toBe(false)
  })
})

describe("signed in", () => {
  it("gives a person with none of these preferences this device's values (first device wins)", async () => {
    localStorage.setItem("aq.recording-countdown.v1", "slow")
    localStorage.setItem("aq.recording-format.v1", "webm")
    localStorage.setItem("aquilla:timelineSnap", "off")
    signIn("ana")
    await refreshPersonPrefs()
    expect(server.record).toEqual({
      commentEmails: "all",
      "recorder.countdown": "slow",
      "recorder.countdownBeep": true,
      "recorder.moveOnAfterSaving": true,
      "recorder.keepTakesDrawerOpen": true,
      "recorder.format": "webm",
      "recorder.filmAudible": false,
      "recorder.filmCollapsed": false,
      "timeline.followPlayhead": true,
      "timeline.snap": false,
    })
    // Offered as setIfAbsent, so a device that got there first would keep its values.
    expect(patches().at(-1)?.body).toMatchObject({ setIfAbsent: { "recorder.countdown": "slow" } })
  })

  it("shows a change made on one device on the other after it reads (the browser check)", async () => {
    signIn("ana")
    await refreshPersonPrefs()
    recorderCountdownBeepPref.set(false)
    timelineFollowPlayheadPref.set(false)
    await flushPersonPrefs()

    useDevice("studio")
    // The studio machine had its own, different device values.
    localStorage.setItem("aq.recording-countdown-beep.v1", "on")
    signIn("ana")
    await refreshPersonPrefs()
    expect(recorderCountdownBeepPref.get()).toBe(false)
    expect(timelineFollowPlayheadPref.get()).toBe(false)
  })

  it("adopts the first device's values instead of offering its own", async () => {
    signIn("ana")
    recorderCountdownPref.set("off")
    await refreshPersonPrefs()

    useDevice("studio")
    localStorage.setItem("aq.recording-countdown.v1", "slow")
    localStorage.setItem("aq.recording-takes-drawer.v1", "closed")
    signIn("ana")
    expect(recorderCountdownPref.get()).toBe("slow") // the device's own, until the read lands
    await refreshPersonPrefs()
    expect(recorderCountdownPref.get()).toBe("off")
    expect(recorderKeepTakesDrawerOpenPref.get()).toBe(true)
    expect(server.record["recorder.countdown"]).toBe("off")
    // The studio's own device keys are untouched, for when nobody is signed in there.
    expect(localStorage.getItem("aq.recording-countdown.v1")).toBe("slow")
  })

  it("keeps the other device's value when both offer at once", async () => {
    signIn("ana")
    localStorage.setItem("aq.recording-format.v1", "webm")
    resetPersonPrefCachesForTests()
    // The other device's offer lands between this one's read and its write.
    server.beforeWrite = () => {
      server.beforeWrite = null
      server.record = { ...server.record, "recorder.format": "wav", "recorder.countdown": "fast" }
    }
    await refreshPersonPrefs()
    expect(server.record["recorder.format"]).toBe("wav")
    expect(recorderFormatPref.get()).toBe("wav")
    expect(recorderCountdownPref.get()).toBe("fast")
  })

  it("sends edits made close together as one merge of just those keys", async () => {
    signIn("ana")
    await refreshPersonPrefs()
    const before = patches().length
    vi.useFakeTimers()
    recorderCountdownPref.set("fast")
    recorderMoveOnAfterSavingPref.set(false)
    recorderFilmAudiblePref.set(true)
    await vi.advanceTimersByTimeAsync(PERSON_PREFS_FLUSH_DELAY_MS + 50)
    expect(patches().length).toBe(before + 1)
    expect(patches().at(-1)?.body).toEqual({
      set: { "recorder.countdown": "fast", "recorder.moveOnAfterSaving": false, "recorder.filmAudible": true },
    })
    expect(server.record.commentEmails).toBe("all")
  })

  it("keeps an edit made offline, through a reload, and sends it once back online", async () => {
    signIn("ana")
    await refreshPersonPrefs()
    setOnline(false)
    recorderFilmCollapsedPref.set(true)
    await flushPersonPrefs()
    expect(server.record["recorder.filmCollapsed"]).toBe(false)

    // Reload while still offline: the edit is still there, and still shown.
    resetPersonPrefsSyncForTests()
    signIn("ana")
    expect(recorderFilmCollapsedPref.get()).toBe(true)

    setOnline(true)
    window.dispatchEvent(new Event("online"))
    await vi.waitFor(() => expect(server.record["recorder.filmCollapsed"]).toBe(true))
  })

  it("retries a save the server could not take, and it lands", async () => {
    signIn("ana")
    await refreshPersonPrefs()
    vi.useFakeTimers()
    server.failWith = 503
    timelineSnapPref.set(false)
    await vi.advanceTimersByTimeAsync(PERSON_PREFS_FLUSH_DELAY_MS + 50)
    expect(server.record["timeline.snap"]).toBe(true)
    server.failWith = null
    await vi.advanceTimersByTimeAsync(2_100)
    expect(server.record["timeline.snap"]).toBe(false)
  })

  it("keeps an edit made while its save is in flight for the next send", async () => {
    signIn("ana")
    await refreshPersonPrefs()
    recorderCountdownPref.set("fast")
    server.beforeWrite = () => {
      server.beforeWrite = null
      recorderCountdownPref.set("slow")
    }
    await flushPersonPrefs()
    expect(server.record["recorder.countdown"]).toBe("fast")
    expect(recorderCountdownPref.get()).toBe("slow")
    await flushPersonPrefs()
    expect(server.record["recorder.countdown"]).toBe("slow")
    expect(recorderCountdownPref.get()).toBe("slow")
  })

  it("does not let a read undo an edit this device has not sent yet", async () => {
    signIn("ana")
    await refreshPersonPrefs()
    setOnline(false)
    recorderCountdownPref.set("off")
    await flushPersonPrefs() // offline: nothing goes
    // Meanwhile another device saves a different countdown.
    server.record = { ...server.record, "recorder.countdown": "slow" }
    setOnline(true)
    // The read gets through; this device's send does not, yet.
    const reads = server.fetch
    globalThis.fetch = (async (input, init) =>
      (init?.method ?? "GET") === "PATCH"
        ? new Response("{}", { status: 503 })
        : reads(input, init)) as typeof fetch
    await refreshPersonPrefs()
    expect(server.record["recorder.countdown"]).toBe("slow")
    expect(recorderCountdownPref.get()).toBe("off")
    // This device's edit is the one the person made here last: it lands.
    globalThis.fetch = server.fetch
    await flushPersonPrefs()
    expect(server.record["recorder.countdown"]).toBe("off")
  })

  it("gives up on an edit the server refuses outright, keeping it on this device", async () => {
    signIn("ana")
    await refreshPersonPrefs()
    server.failWith = 400
    recorderCountdownPref.set("fast")
    await flushPersonPrefs()
    server.failWith = null
    const sends = patches().length
    await flushPersonPrefs()
    expect(patches().length).toBe(sends)
    expect(recorderCountdownPref.get()).toBe("fast")
  })
})

describe("a preference whose module loads after the first read (a lazy chunk)", () => {
  const lateSwitch = (serverKey: string) => ({
    serverKey,
    deviceKey: `aq.test-${serverKey}`,
    defaultValue: false,
    parse: (v: unknown) => (typeof v === "boolean" ? v : undefined),
    toDevice: (on: boolean) => (on ? "on" : null),
    fromDevice: (raw: string | null) => raw === "on",
  })

  it("still finds the value the person's record holds", async () => {
    server.record = { ...server.record, "test.lateHeld": true }
    signIn("ana")
    await refreshPersonPrefs()
    const late = definePersonPref(lateSwitch("test.lateHeld"))
    expect(late.get()).toBe(true)
  })

  it("offers this device's value when the record has none", async () => {
    localStorage.setItem("aq.test-test.lateMissing", "on")
    signIn("ana")
    await refreshPersonPrefs()
    vi.useFakeTimers()
    definePersonPref(lateSwitch("test.lateMissing"))
    await vi.advanceTimersByTimeAsync(PERSON_PREFS_FLUSH_DELAY_MS + 50)
    expect(server.record["test.lateMissing"]).toBe(true)
    expect(patches().at(-1)?.body).toEqual({ setIfAbsent: { "test.lateMissing": true } })
  })
})

describe("two people on one browser", () => {
  it("never shows one person's values to the other", async () => {
    signIn("ana")
    await refreshPersonPrefs()
    recorderCountdownPref.set("off")
    await flushPersonPrefs()
    const anaRecord = { ...server.record }

    // Bob signs in on the same browser; his record is his own.
    const anaServer = server
    server = createFakePreferencesServer({ "recorder.countdown": "slow" })
    globalThis.fetch = server.fetch
    signIn("bob")
    expect(recorderCountdownPref.get()).toBe("normal") // this device's own value until his read lands
    await refreshPersonPrefs()
    expect(recorderCountdownPref.get()).toBe("slow")
    recorderFormatPref.set("webm")
    await flushPersonPrefs()
    expect(anaServer.record).toEqual(anaRecord)

    // Ana again: hers, from this browser's cache, at once.
    globalThis.fetch = anaServer.fetch
    signIn("ana")
    expect(recorderCountdownPref.get()).toBe("off")
    expect(recorderFormatPref.get()).toBe("wav")

    // Signed out: the device's own value, which neither of them changed.
    signOut()
    expect(recorderCountdownPref.get()).toBe("normal")
  })
})
