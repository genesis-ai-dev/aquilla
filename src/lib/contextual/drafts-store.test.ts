// Live autopilot drafts store. WHY: this store is the only thing standing
// between "the run staged 400 verified translations" and the user seeing any
// of them, so its failure modes are all silent-loss shaped. Each test pins one:
//
//   - a burst must land in the cells it names (the whole feature)
//   - a truncated burst must ASK for the rest instead of quietly showing part
//     of a wave as though it were all of it
//   - a decision must clear the cell immediately (the review call is a report,
//     not a gate — a draft that lingers after a click reads as broken)
//   - counters must describe what the PERSON did, not what the server holds

import { describe, it, expect, beforeEach } from "vitest"
import {
  applyContextualDraftsFrame as applyFrame,
  attachContextualDrafts,
  getContextualDraftFor as getDraft,
  getContextualDrafts,
  getContextualDraftsSummary,
  hydrateContextualDrafts as hydrateScope,
  listPendingDrafts,
  resetContextualDraftsStore,
  resolveContextualDraft as resolveDraft,
} from "./drafts-store"

const RUN = "01920000-0000-7000-8000-000000000001"
const PROJECT = "project-1"

function hydrateContextualDrafts(
  fileId: string,
  drafts: { draftId: string; runId?: string; cellId: string; text: string; spanLabel?: string }[],
  projectId = PROJECT,
  targetLang = "",
) {
  return hydrateScope(attachContextualDrafts(projectId, fileId, targetLang), drafts)
}

function applyContextualDraftsFrame(frame: ReturnType<typeof burst>, projectId = PROJECT) {
  return applyFrame(projectId, frame, RUN)
}

function getContextualDraftFor(cellId: string, projectId = PROJECT, fileId = "file-1", targetLang = "") {
  return getDraft(projectId, fileId, targetLang, cellId)
}

function resolveContextualDraft(cellId: string, action: "accepted" | "rejected") {
  const draftId = getContextualDraftFor(cellId)?.draftId ?? "missing"
  return resolveDraft(PROJECT, "file-1", "", cellId, draftId, action)
}

function burst(
  drafts: { draftId: string; cellId: string; text: string }[],
  opts: { fileId?: string; targetLang?: string; spanLabel?: string; truncated?: boolean } = {},
) {
  return {
    type: "contextual.drafts" as const,
    runId: RUN,
    fileId: opts.fileId ?? "file-1",
    targetLang: opts.targetLang ?? "",
    spanLabel: opts.spanLabel ?? "LUK 1:1–1:8",
    drafts,
    ...(opts.truncated ? { truncated: true } : {}),
  }
}

beforeEach(() => {
  resetContextualDraftsStore()
})

describe("draft bursts", () => {
  it("lands every draft in the cell it names, with its passage label", () => {
    hydrateContextualDrafts("file-1", [])
    applyContextualDraftsFrame(
      burst([
        { draftId: "d1", cellId: "c1", text: "En el principio" },
        { draftId: "d2", cellId: "c2", text: "era el Verbo" },
      ]),
    )

    expect(getContextualDrafts().size).toBe(2)
    expect(getContextualDraftFor("c2")).toMatchObject({
      draftId: "d2",
      text: "era el Verbo",
      spanLabel: "LUK 1:1–1:8",
    })
    expect(getContextualDraftsSummary().pending).toBe(2)
  })

  it("accumulates across spans — a wave delivers several bursts at once", () => {
    hydrateContextualDrafts("file-1", [])
    applyContextualDraftsFrame(burst([{ draftId: "d1", cellId: "c1", text: "one" }]))
    applyContextualDraftsFrame(
      burst([{ draftId: "d2", cellId: "c2", text: "two" }], { spanLabel: "LUK 2:1–2:9" }),
    )

    expect(getContextualDrafts().size).toBe(2)
    expect(getContextualDraftFor("c2")?.spanLabel).toBe("LUK 2:1–2:9")
  })

  it("lets a re-proposal replace the pending draft on the same cell", () => {
    hydrateContextualDrafts("file-1", [])
    applyContextualDraftsFrame(burst([{ draftId: "d1", cellId: "c1", text: "first try" }]))
    applyContextualDraftsFrame(burst([{ draftId: "d2", cellId: "c1", text: "after steering" }]))

    expect(getContextualDrafts().size).toBe(1)
    expect(getContextualDraftFor("c1")).toMatchObject({ draftId: "d2", text: "after steering" })
  })

  it("refetches instead of applying a delayed burst from a superseded run", () => {
    hydrateContextualDrafts("file-1", [
      { draftId: "new", runId: "run-b", cellId: "c1", text: "run B text" },
    ])
    const delayedA = { ...burst([{ draftId: "old", cellId: "c1", text: "stale run A text" }]), runId: "run-a" }

    const result = applyFrame(PROJECT, delayedA, "run-b")

    expect(result.needsRefetch).toBe(true)
    expect(getContextualDraftFor("c1")?.text).toBe("run B text")
    expect(getContextualDraftFor("c1")?.runId).toBe("run-b")
  })

  it("asks for a refetch when the burst was truncated", () => {
    hydrateContextualDrafts("file-1", [])
    const partial = applyContextualDraftsFrame(
      burst([{ draftId: "d1", cellId: "c1", text: "one of many" }], { truncated: true }),
    )
    expect(partial.needsRefetch).toBe(true)
    expect(getContextualDraftFor("c1")).toBeUndefined()

    const whole = applyContextualDraftsFrame(burst([{ draftId: "d2", cellId: "c2", text: "all" }]))
    expect(whole.needsRefetch).toBe(false)
  })

  it("ignores drafts for a file that isn't open", () => {
    hydrateContextualDrafts("file-1", [])
    applyContextualDraftsFrame(
      burst([{ draftId: "dx", cellId: "cx", text: "other document" }], { fileId: "file-2" }),
    )
    expect(getContextualDrafts().size).toBe(0)
  })

  it("fails closed when a frame arrives before an editor scope is bound", () => {
    applyContextualDraftsFrame(burst([{ draftId: "d1", cellId: "c1", text: "early" }]))
    expect(getContextualDraftFor("c1")).toBeUndefined()
  })

  it("drops project-wide frames outside the exact attached project and file", () => {
    hydrateContextualDrafts("shared-file", [], "project-b")

    applyContextualDraftsFrame(
      burst([{ draftId: "from-a", cellId: "c1", text: "project A text" }], { fileId: "shared-file" }),
      "project-a",
    )
    applyContextualDraftsFrame(
      burst([{ draftId: "wrong-file", cellId: "c1", text: "other file text" }], { fileId: "other-file" }),
      "project-b",
    )

    expect(getContextualDrafts()).toHaveLength(0)
  })

  it("drops default-lane frames while a multilingual lane is open", () => {
    attachContextualDrafts(PROJECT, "file-1", "fr")

    applyContextualDraftsFrame(burst([{ draftId: "d1", cellId: "c1", text: "default text" }]))

    expect(getContextualDrafts()).toHaveLength(0)
    expect(getContextualDraftsSummary()).toMatchObject({ targetLang: "fr", pending: 0 })
  })

  it("drops a frame that declares a non-default producer lane", () => {
    hydrateContextualDrafts("file-1", [])

    applyContextualDraftsFrame(burst(
      [{ draftId: "d1", cellId: "c1", text: "legacy lane text" }],
      { targetLang: "fr" },
    ))

    expect(getContextualDrafts().size).toBe(0)
  })

  it("orders the review queue newest first", () => {
    hydrateContextualDrafts("file-1", [])
    applyContextualDraftsFrame(burst([{ draftId: "d1", cellId: "c1", text: "older" }]))
    applyContextualDraftsFrame(burst([{ draftId: "d2", cellId: "c2", text: "newer" }]))

    expect(listPendingDrafts().map((d) => d.cellId)).toEqual(["c2", "c1"])
  })
})

describe("hydration", () => {
  it("replaces the mirror from the authoritative list", () => {
    hydrateContextualDrafts("file-1", [])
    applyContextualDraftsFrame(burst([{ draftId: "stale", cellId: "c9", text: "gone" }]))
    hydrateContextualDrafts("file-1", [{ draftId: "d1", cellId: "c1", text: "server truth" }])

    expect(getContextualDrafts().size).toBe(1)
    expect(getContextualDraftFor("c9")).toBeUndefined()
    expect(getContextualDraftFor("c1")?.text).toBe("server truth")
  })

  it("keeps session counters within a file and resets them across files", () => {
    hydrateContextualDrafts("file-1", [{ draftId: "d1", cellId: "c1", text: "a" }])
    resolveContextualDraft("c1", "accepted")
    expect(getContextualDraftsSummary().acceptedThisSession).toBe(1)

    // A reconnect on the SAME file must not zero what the user just did.
    hydrateContextualDrafts("file-1", [])
    expect(getContextualDraftsSummary().acceptedThisSession).toBe(1)

    hydrateContextualDrafts("file-2", [])
    expect(getContextualDraftsSummary().acceptedThisSession).toBe(0)
    expect(getContextualDraftsSummary().fileId).toBe("file-2")
  })

  it("rejects a late project-A response after switching to project B with the same file id", async () => {
    let releaseA!: (drafts: { draftId: string; cellId: string; text: string }[]) => void
    const responseA = new Promise<{ draftId: string; cellId: string; text: string }[]>((resolve) => {
      releaseA = resolve
    })
    const scopeA = attachContextualDrafts("project-a", "shared-file", "")
    const lateHydration = responseA.then((drafts) => hydrateScope(scopeA, drafts))

    const scopeB = attachContextualDrafts("project-b", "shared-file", "")
    expect(hydrateScope(scopeB, [{ draftId: "b", cellId: "c1", text: "project B text" }])).toBe(true)
    releaseA([{ draftId: "a", cellId: "c1", text: "project A text" }])

    expect(await lateHydration).toBe(false)
    expect(getContextualDraftsSummary()).toMatchObject({
      projectId: "project-b",
      fileId: "shared-file",
      targetLang: "",
      pending: 1,
    })
    expect(getDraft("project-b", "shared-file", "", "c1")?.text).toBe("project B text")
    expect(getDraft("project-a", "shared-file", "", "c1")).toBeUndefined()
  })

  it("rejects a default-lane snapshot after switching the same project/file to another lane", () => {
    const defaultScope = attachContextualDrafts(PROJECT, "file-1", "")
    attachContextualDrafts(PROJECT, "file-1", "fr")

    expect(hydrateScope(defaultScope, [{ draftId: "d1", cellId: "c1", text: "default text" }])).toBe(false)
    expect(getContextualDraftsSummary()).toMatchObject({ targetLang: "fr", pending: 0 })
    expect(getContextualDrafts()).toHaveLength(0)
  })
})

describe("decisions", () => {
  it("clears the cell immediately and counts the acceptance", () => {
    hydrateContextualDrafts("file-1", [
      { draftId: "d1", cellId: "c1", text: "a" },
      { draftId: "d2", cellId: "c2", text: "b" },
    ])
    resolveContextualDraft("c1", "accepted")

    expect(getContextualDraftFor("c1")).toBeUndefined()
    expect(getContextualDraftsSummary()).toMatchObject({
      pending: 1,
      acceptedThisSession: 1,
      rejectedThisSession: 0,
    })
  })

  it("counts a rejection without crediting it as work accepted", () => {
    hydrateContextualDrafts("file-1", [{ draftId: "d1", cellId: "c1", text: "a" }])
    resolveContextualDraft("c1", "rejected")

    expect(getContextualDraftsSummary()).toMatchObject({
      pending: 0,
      acceptedThisSession: 0,
      rejectedThisSession: 1,
    })
  })

  it("is a no-op on a cell with no pending draft", () => {
    hydrateContextualDrafts("file-1", [{ draftId: "d1", cellId: "c1", text: "a" }])
    resolveContextualDraft("nope", "accepted")

    expect(getContextualDraftsSummary()).toMatchObject({ pending: 1, acceptedThisSession: 0 })
  })

  it("cannot resolve a draft through a stale project, file, or lane control", () => {
    hydrateContextualDrafts("shared-file", [{ draftId: "d1", cellId: "c1", text: "safe" }], "project-b")

    expect(resolveDraft("project-a", "shared-file", "", "c1", "d1", "accepted")).toBe(false)
    expect(resolveDraft("project-b", "other-file", "", "c1", "d1", "accepted")).toBe(false)
    expect(resolveDraft("project-b", "shared-file", "fr", "c1", "d1", "accepted")).toBe(false)
    expect(getContextualDraftsSummary()).toMatchObject({ pending: 1, acceptedThisSession: 0 })
  })

  it("never removes a replacement draft with the same cell id", () => {
    hydrateContextualDrafts("file-1", [{ draftId: "draft-b", cellId: "c1", text: "newer" }])

    expect(resolveDraft(PROJECT, "file-1", "", "c1", "draft-a", "accepted")).toBe(false)
    expect(getContextualDraftFor("c1")).toMatchObject({ draftId: "draft-b", text: "newer" })
  })
})
