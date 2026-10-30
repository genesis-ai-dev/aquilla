// AQU-2264: a person's preferences follow them across devices, in
// `users.preferences`. `PATCH /api/v2/auth/me` REPLACES that whole blob, so
// every caller had to read it, change one key and send it all back — and two
// devices (or two features) doing that at the same time lose one write.
//
// `PATCH /api/v2/auth/me/preferences` merges instead: only the keys sent are
// written, in one UPDATE, so writers that touch different keys never undo
// each other. `setIfAbsent` writes a key only when the person has none yet
// (the first device's values become theirs). `GET /api/v2/auth/me/preferences`
// reads the row itself, never the 30-second session cache, so a second device
// sees a write the moment it lands.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function patchPrefs(username: string, body: unknown): Promise<Response> {
  return app.request(
    "/api/v2/auth/me/preferences",
    { method: "PATCH", headers: authHeader(await jwtFor(username)), body: JSON.stringify(body) },
    env,
  )
}

async function getPrefs(username: string): Promise<Response> {
  return app.request("/api/v2/auth/me/preferences", { headers: authHeader(await jwtFor(username)) }, env)
}

async function stored(id: number): Promise<Record<string, unknown>> {
  const row = await env.AQUILLA_PG.prepare("SELECT preferences FROM users WHERE id = ?")
    .bind(id)
    .first<{ preferences: string }>()
  return JSON.parse(row?.preferences ?? "{}") as Record<string, unknown>
}

async function setStoredText(id: number, text: string): Promise<void> {
  await env.AQUILLA_PG.prepare("UPDATE users SET preferences = ? WHERE id = ?").bind(text, id).run()
}

describe("PATCH /api/v2/auth/me/preferences (AQU-2264)", () => {
  it("writes only the keys sent and keeps every other preference", async () => {
    await seedUser(1, "ana")
    await setStoredText(1, JSON.stringify({ theme: "dark", commentEmails: "all" }))
    const res = await patchPrefs("ana", { set: { "recorder.countdown": "fast" } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      preferences: { theme: "dark", commentEmails: "all", "recorder.countdown": "fast" },
    })
    expect(await stored(1)).toEqual({ theme: "dark", commentEmails: "all", "recorder.countdown": "fast" })
  })

  it("lets two writers that started from the same record both land", async () => {
    await seedUser(1, "ana")
    // Two devices, or the comment-email card and the recorder, write at once.
    // Each sends only its own key; neither has to read the other's first.
    const [a, b] = await Promise.all([
      patchPrefs("ana", { set: { commentEmails: "off" } }),
      patchPrefs("ana", { set: { "recorder.countdown": "slow", "timeline.snap": false } }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(await stored(1)).toEqual({
      commentEmails: "off",
      "recorder.countdown": "slow",
      "timeline.snap": false,
    })
  })

  it("is not undone by a later write of a different key from a stale device", async () => {
    await seedUser(1, "ana")
    await patchPrefs("ana", { set: { "recorder.countdown": "off" } })
    // A second device that last read the record before that write changes
    // only the beep. The countdown it never touched stays as the first set it.
    await patchPrefs("ana", { set: { "recorder.countdownBeep": false } })
    expect(await stored(1)).toEqual({ "recorder.countdown": "off", "recorder.countdownBeep": false })
  })

  it("setIfAbsent fills only the keys the person has none of (first device wins)", async () => {
    await seedUser(1, "ana")
    const first = await patchPrefs("ana", {
      setIfAbsent: { "recorder.countdown": "fast", "recorder.format": "webm" },
    })
    expect(first.status).toBe(200)
    // A second device offers its own values: the ones already there stay.
    const second = await patchPrefs("ana", {
      setIfAbsent: { "recorder.countdown": "slow", "timeline.followPlayhead": false },
    })
    expect(await second.json()).toEqual({
      preferences: {
        "recorder.countdown": "fast",
        "recorder.format": "webm",
        "timeline.followPlayhead": false,
      },
    })
  })

  it("applies set over setIfAbsent and over what is stored", async () => {
    await seedUser(1, "ana")
    await setStoredText(1, JSON.stringify({ "recorder.countdown": "normal" }))
    await patchPrefs("ana", {
      setIfAbsent: { "recorder.countdown": "slow", "recorder.format": "wav" },
      set: { "recorder.countdown": "off", "recorder.format": "webm" },
    })
    expect(await stored(1)).toEqual({ "recorder.countdown": "off", "recorder.format": "webm" })
  })

  it("treats a stored record that is not a JSON object as empty", async () => {
    await seedUser(1, "ana")
    await setStoredText(1, "not json at all")
    expect((await patchPrefs("ana", { set: { a: 1 } })).status).toBe(200)
    expect(await stored(1)).toEqual({ a: 1 })
    await setStoredText(1, "[1,2]")
    expect((await patchPrefs("ana", { set: { b: 2 } })).status).toBe(200)
    expect(await stored(1)).toEqual({ b: 2 })
  })

  it("refuses an empty, malformed or oversized request without writing", async () => {
    await seedUser(1, "ana")
    await setStoredText(1, JSON.stringify({ theme: "dark" }))
    expect((await patchPrefs("ana", {})).status).toBe(400)
    expect((await patchPrefs("ana", { set: {} })).status).toBe(400)
    expect((await patchPrefs("ana", { set: "dark" })).status).toBe(400)
    expect((await patchPrefs("ana", { preferences: { theme: "light" } })).status).toBe(400)
    expect((await patchPrefs("ana", { set: { ["k".repeat(101)]: 1 } })).status).toBe(400)
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i]))
    expect((await patchPrefs("ana", { set: many })).status).toBe(400)
    expect((await patchPrefs("ana", { set: { big: "x".repeat(17 * 1024) } })).status).toBe(413)
    expect(await stored(1)).toEqual({ theme: "dark" })
  })

  it("stops growing a record that is already very large", async () => {
    await seedUser(1, "ana")
    await setStoredText(1, JSON.stringify({ huge: "x".repeat(300 * 1024) }))
    expect((await patchPrefs("ana", { set: { a: 1 } })).status).toBe(413)
  })

  it("needs a signed-in person", async () => {
    const res = await app.request(
      "/api/v2/auth/me/preferences",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ set: { a: 1 } }) },
      env,
    )
    expect(res.status).toBe(401)
  })

  it("leaves PATCH /auth/me's replace behaviour alone for older clients", async () => {
    await seedUser(1, "ana")
    await patchPrefs("ana", { set: { "recorder.countdown": "fast" } })
    await app.request(
      "/api/v2/auth/me",
      { method: "PATCH", headers: authHeader(await jwtFor("ana")), body: JSON.stringify({ preferences: { theme: "dark" } }) },
      env,
    )
    expect(await stored(1)).toEqual({ theme: "dark" })
  })
})

describe("GET /api/v2/auth/me/preferences (AQU-2264)", () => {
  it("returns the stored record, or {} when there is none", async () => {
    await seedUser(1, "ana")
    expect(await (await getPrefs("ana")).json()).toEqual({ preferences: {} })
    await patchPrefs("ana", { set: { "timeline.snap": false } })
    expect(await (await getPrefs("ana")).json()).toEqual({ preferences: { "timeline.snap": false } })
  })

  it("reads the row, not the session cache, so another device's write shows at once", async () => {
    await seedUser(1, "ana")
    const token = await jwtFor("ana")
    // This isolate caches the session (and its preferences) for 30 seconds.
    await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    // Another device's write lands through a different isolate: only the row changes.
    await setStoredText(1, JSON.stringify({ "recorder.countdown": "slow" }))
    const res = await app.request("/api/v2/auth/me/preferences", { headers: authHeader(token) }, env)
    expect(await res.json()).toEqual({ preferences: { "recorder.countdown": "slow" } })
  })

  it("needs a signed-in person", async () => {
    const res = await app.request("/api/v2/auth/me/preferences", {}, env)
    expect(res.status).toBe(401)
  })
})
