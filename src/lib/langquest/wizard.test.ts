// The New-project wizard is one choice per step, and a saved LangQuest
// connection is what spares the second project a token paste: these pin the
// walk the dialog renders from (AQU-2105 follow-up).

import { describe, expect, it } from "vitest"
import {
  connectUrlFor,
  INITIAL_WIZARD_STATE,
  isUsable,
  langquestConnectUrl,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from "./wizard"
import type { LangQuestConnection } from "./types"

const conn = (id: string, health: LangQuestConnection["health"] = "ok"): LangQuestConnection => ({
  id,
  apiBase: "https://next.langquest.org/api/v1",
  org: { id: `org-${id}`, name: `Org ${id}` },
  token: { id: "t", name: "Aquilla", scopes: ["read"], expiresAt: null, allLanguages: true },
  health,
  lastCheckedAt: null,
  lastError: null,
  linkedProjects: 0,
  connectedAt: null,
  updatedAt: null,
})

const walk = (state: WizardState, ...actions: WizardAction[]) => actions.reduce(wizardReducer, state)

describe("where the project comes from", () => {
  it("starts on the source choice and routes scratch/linked to the form with that shape", () => {
    expect(INITIAL_WIZARD_STATE.step).toEqual({ kind: "source" })
    expect(walk(INITIAL_WIZARD_STATE, { type: "pickSource", source: "scratch" }).step).toEqual({ kind: "form", source: "scratch" })
    expect(walk(INITIAL_WIZARD_STATE, { type: "pickSource", source: "linked" }).step).toEqual({ kind: "form", source: "linked" })
  })

  it("picking LangQuest before the saved connections are known waits on them, then decides", () => {
    const waiting = walk(INITIAL_WIZARD_STATE, { type: "pickSource", source: "langquest" })
    expect(waiting.step).toEqual({ kind: "loading" })
    expect(walk(waiting, { type: "connectionsLoaded", connections: [] }).step).toEqual({ kind: "connect" })
    expect(walk(waiting, { type: "connectionsLoaded", connections: [conn("a")] }).step).toEqual({ kind: "org" })
    expect(walk(waiting, { type: "back" }).step).toEqual({ kind: "source" })
  })

  it("with no saved connection, LangQuest goes straight to connecting (there is no org to pick)", () => {
    const known = walk(INITIAL_WIZARD_STATE, { type: "connectionsLoaded", connections: [] })
    expect(walk(known, { type: "pickSource", source: "langquest" }).step).toEqual({ kind: "connect" })
  })

  it("with a saved connection, LangQuest asks which org first", () => {
    const loaded = walk(INITIAL_WIZARD_STATE, { type: "connectionsLoaded", connections: [conn("a")] })
    expect(walk(loaded, { type: "pickSource", source: "langquest" }).step).toEqual({ kind: "org" })
  })

  it("connections arriving late re-decide the connect/org fork but nothing else", () => {
    const onConnect = walk(INITIAL_WIZARD_STATE, { type: "connectionsLoaded", connections: [] }, { type: "pickSource", source: "langquest" })
    expect(walk(onConnect, { type: "connectionsLoaded", connections: [conn("a")] }).step).toEqual({ kind: "org" })
    const onForm = walk(INITIAL_WIZARD_STATE, { type: "pickSource", source: "scratch" })
    expect(walk(onForm, { type: "connectionsLoaded", connections: [conn("a")] }).step).toEqual({ kind: "form", source: "scratch" })
  })
})

describe("the LangQuest steps", () => {
  const withOrg = walk(INITIAL_WIZARD_STATE, { type: "connectionsLoaded", connections: [conn("a"), conn("b", "needs_reauth")] }, { type: "pickSource", source: "langquest" })

  it("picking a healthy org skips the token paste and goes to its languages", () => {
    expect(walk(withOrg, { type: "pickConnection", connectionId: "a" }).step).toEqual({ kind: "language", connectionId: "a" })
  })

  it("a broken org cannot be picked — it has to be reconnected", () => {
    expect(walk(withOrg, { type: "pickConnection", connectionId: "b" }).step).toEqual({ kind: "org" })
    expect(isUsable(conn("x", "needs_reauth"))).toBe(false)
    expect(isUsable(conn("x", "expired"))).toBe(false)
    // A probe that got no verdict does not block linking: the link call will say.
    expect(isUsable(conn("x", "unreachable"))).toBe(true)
  })

  it("connecting a new org adds it and continues to its languages", () => {
    const next = walk(withOrg, { type: "startConnect" }, { type: "connected", connection: conn("c") })
    expect(next.step).toEqual({ kind: "language", connectionId: "c" })
    expect(next.connections.map((c) => c.id)).toEqual(["a", "b", "c"])
  })

  it("reconnecting an org replaces its entry rather than duplicating it", () => {
    const next = walk(withOrg, { type: "startConnect" }, { type: "connected", connection: conn("b", "ok") })
    expect(next.connections.map((c) => [c.id, c.health])).toEqual([["a", "ok"], ["b", "ok"]])
    expect(next.step).toEqual({ kind: "language", connectionId: "b" })
  })

  it("language → details carries both ids", () => {
    const next = walk(withOrg, { type: "pickConnection", connectionId: "a" }, { type: "pickLanguage", languageId: "lang-1" })
    expect(next.step).toEqual({ kind: "details", connectionId: "a", languageId: "lang-1" })
  })

  it("back retraces one step at a time, and from connect returns to the org list only if there is one", () => {
    const details = walk(withOrg, { type: "pickConnection", connectionId: "a" }, { type: "pickLanguage", languageId: "lang-1" })
    expect(walk(details, { type: "back" }).step).toEqual({ kind: "language", connectionId: "a" })
    expect(walk(details, { type: "back" }, { type: "back" }).step).toEqual({ kind: "org" })
    expect(walk(details, { type: "back" }, { type: "back" }, { type: "back" }).step).toEqual({ kind: "source" })
    expect(walk(withOrg, { type: "startConnect" }, { type: "back" }).step).toEqual({ kind: "org" })
    const noOrgs = walk(INITIAL_WIZARD_STATE, { type: "connectionsLoaded", connections: [] }, { type: "pickSource", source: "langquest" })
    expect(walk(noOrgs, { type: "back" }).step).toEqual({ kind: "source" })
  })

  it("reset returns to the source choice but keeps what it knows about connections", () => {
    const next = walk(withOrg, { type: "pickConnection", connectionId: "a" }, { type: "reset" })
    expect(next.step).toEqual({ kind: "source" })
    expect(next.connections).toHaveLength(2)
  })
})

describe("the Connect URL", () => {
  it("is derived from the API base so a preview connection opens the preview app", () => {
    expect(langquestConnectUrl("https://next-preview.langquest.org/api/v1")).toBe("https://next-preview.langquest.org/connect")
    expect(langquestConnectUrl(undefined)).toBe("https://next.langquest.org/connect")
    expect(langquestConnectUrl("not a url")).toBe("https://next.langquest.org/connect")
    expect(connectUrlFor([])).toBe("https://next.langquest.org/connect")
    expect(connectUrlFor([{ apiBase: "https://next-preview.langquest.org/api/v1" }])).toBe("https://next-preview.langquest.org/connect")
  })
})
