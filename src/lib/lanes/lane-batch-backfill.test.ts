import { describe, expect, it } from "vitest"
import {
  GUESSED_LANE_LANGUAGE_REASON,
  LANE_BATCH_READ_ONLY_OPTIONS,
  LANE_BATCH_SQL,
  laneBatchApplyRefusal,
  laneBatchClientConfig,
  planLaneBatch,
  renderLaneBatchReport,
  selectAudioLaneEvent,
  type LaneBatchPlan,
  type LaneBatchProject,
  type LaneBatchSnapshot,
  type LaneBatchWrite,
} from "./lane-batch-backfill"

function project(overrides: Partial<LaneBatchProject> = {}): LaneBatchProject {
  return {
    id: "p1",
    name: "Fixture",
    sourceLanguage: "English",
    targetLanguage: "Spanish",
    sourceProjectId: null,
    sourceLinkConsumes: null,
    sourceLinkLaneId: null,
    lanes: [],
    scopes: [],
    invites: [],
    audio: [],
    audioValidators: [],
    backtranslations: [],
    concepts: [],
    files: [],
    progress: [],
    ...overrides,
  }
}

function plan(projects: LaneBatchProject[], projectId?: string): LaneBatchPlan {
  return planLaneBatch({ projects }, projectId ? { projectId } : undefined)
}

function laneWrites(writes: LaneBatchWrite[]) {
  return writes.filter((write) => write.table === "lanes")
}

function after(snapshot: LaneBatchSnapshot, planned: LaneBatchPlan): LaneBatchSnapshot {
  const next = structuredClone(snapshot)
  for (const write of planned.writes) {
    const row = next.projects.find((item) => item.id === write.projectId)
    if (!row) throw new Error(`missing project ${write.projectId}`)
    if (write.table === "lanes") {
      const lane = row.lanes.find((item) => item.id === write.laneId)
      if (!lane) throw new Error(`missing lane ${write.laneId}`)
      lane.language = write.language
      lane.name = write.name
      lane.langCode = null
    } else if (write.table === "project_member_scopes") {
      if (write.action === "delete") {
        row.scopes = row.scopes.filter((scope) => !(scope.userId === write.userId && scope.value === write.from))
      } else {
        const scope = row.scopes.find((item) => item.userId === write.userId && item.value === write.from)
        if (!scope || !write.to) throw new Error("scope update missing")
        scope.value = write.to
      }
    } else if (write.table === "project_invites") {
      const invite = row.invites.find((item) => item.token === write.token)
      if (!invite) throw new Error("invite missing")
      invite.scopeLanes = write.scopeLanes
    } else if (write.table === "projects") {
      row.sourceLinkLaneId = write.sourceLinkLaneId
    } else if (write.table === "cell_audio") {
      const take = row.audio.find((item) => item.audioId === write.audioId)
      if (!take) throw new Error("take missing")
      take.laneId = write.laneId
    } else if (write.table === "cell_audio_validators") {
      const vote = row.audioValidators.find((item) => item.audioId === write.audioId && item.username === write.username)
      if (!vote) throw new Error("vote missing")
      vote.laneId = write.laneId
    } else if (write.table === "cell_backtranslations") {
      const bt = row.backtranslations.find((item) => item.targetEventId === write.targetEventId)
      if (!bt) throw new Error("back-translation missing")
      bt.laneId = write.laneId
    } else if (write.table === "concepts") {
      const concept = row.concepts.find((item) => item.conceptId === write.conceptId)
      if (!concept) throw new Error("concept missing")
      concept.renderings = write.renderings
    }
  }
  for (const file of planned.progressFiles) {
    const row = next.projects.find((item) => item.id === file.projectId)
    const source = row?.lanes.find((lane) => lane.role === "source")
    if (!row || !source) continue
    const present = row.progress.some(
      (item) => item.fileId === file.fileId && item.scope === "file" && item.sectionKey === "" && item.laneId === source.id,
    )
    if (!present) {
      row.progress.push({ fileId: file.fileId, scope: "file", sectionKey: "", laneId: source.id, targetLang: "" })
    }
  }
  return next
}

describe("lane batch backfill", () => {
  it("fills lane language from settings and tags, and clears derived names and codes", () => {
    const planned = plan([
      project({
        lanes: [
          { id: "src", role: "source", name: "English", langCode: "en", legacyTag: null, language: null },
          { id: "def", role: "target", name: "Spanish", langCode: "es", legacyTag: "", language: null },
          { id: "fr", role: "target", name: "French Team", langCode: "fr", legacyTag: "French", language: null },
          { id: "esname", role: "target", name: "es", langCode: null, legacyTag: "Spanish", language: null },
          { id: "blank", role: "target", name: "Untitled lane", langCode: null, legacyTag: "a3f09c1e", language: null },
          { id: "a3f09c1e", role: "target", name: "German", langCode: "de", legacyTag: "a3f09c1e", language: null },
        ],
      }),
    ])
    const byId = Object.fromEntries(
      laneWrites(planned.writes).map((write) => [write.laneId, write]),
    )
    expect(byId.src).toMatchObject({ language: "English", name: null, langCode: null })
    expect(byId.def).toMatchObject({ language: "Spanish", name: null, langCode: null })
    expect(byId.fr).toMatchObject({ language: "French", name: "French Team", langCode: null })
    expect(byId.esname).toMatchObject({ language: "Spanish", name: null, langCode: null })
    expect(byId.blank).toMatchObject({ language: null, name: null, langCode: null })
    expect(byId.a3f09c1e).toMatchObject({ language: "German", name: null, langCode: null })
    expect(planned.report.guessedLanguages).toEqual([
      {
        projectId: "p1",
        projectName: "Fixture",
        laneId: "a3f09c1e",
        legacyTag: "a3f09c1e",
        name: "German",
        language: "German",
        reason: GUESSED_LANE_LANGUAGE_REASON,
      },
    ])
    expect(planned.report.counts.lanes.leftEmpty).toBe(1)
    expect(planned.report.counts.lanes.guessed).toBe(1)
    expect(planned.writes.some((write) => write.table === "lanes" && "legacyTag" in write)).toBe(false)
  })

  it("keeps a stored language and a real name when settings are empty", () => {
    const planned = plan([
      project({
        sourceLanguage: "",
        targetLanguage: "",
        lanes: [
          { id: "src", role: "source", name: "English", langCode: "en", legacyTag: null, language: null },
          { id: "src2", role: "source", name: "Koiné", langCode: null, legacyTag: null, language: "Kept" },
        ],
      }),
    ])
    expect(laneWrites(planned.writes)).toEqual([
      { table: "lanes", projectId: "p1", laneId: "src", language: null, name: "English", langCode: null },
    ])
    expect(planned.report.counts.lanes.unchanged).toBe(1)
  })

  it("reports AQU-1585 disagreements and duplicate names without deleting the lane", () => {
    const planned = plan([
      project({
        targetLanguage: "Portuguese",
        lanes: [
          { id: "src", role: "source", name: "English", langCode: null, legacyTag: null, language: "English" },
          { id: "def", role: "target", name: "Spanish", langCode: "pt", legacyTag: "", language: null },
          { id: "extra", role: "target", name: "Spanish", langCode: "es", legacyTag: "Spanish", language: null },
        ],
      }),
    ])
    expect(planned.report.aqu1585.disagreements).toEqual([
      {
        projectId: "p1",
        projectName: "Fixture",
        laneId: "def",
        name: "Spanish",
        langCode: "pt",
        derivedCode: "es",
      },
    ])
    expect(planned.report.aqu1585.duplicateNames).toEqual([
      { projectId: "p1", projectName: "Fixture", name: "Spanish", laneIds: ["def", "extra"] },
    ])
    const def = laneWrites(planned.writes).find((write) => write.laneId === "def")
    const extra = laneWrites(planned.writes).find((write) => write.laneId === "extra")
    expect(def).toMatchObject({ language: "Portuguese", name: "Spanish", langCode: null })
    expect(extra).toMatchObject({ language: "Spanish", name: null, langCode: null })
    expect(planned.writes.some((write) => write.table === "project_member_scopes" && write.action === "delete" && write.from === "extra")).toBe(false)
    expect(JSON.stringify(planned.writes)).not.toContain("DELETE FROM lanes")
  })

  it("converts scope tags that name one lane and reports zero and two", () => {
    const planned = plan([
      project({
        lanes: [
          { id: "src", role: "source", name: "English", langCode: null, legacyTag: null, language: "English" },
          { id: "def", role: "target", name: "Spanish", langCode: null, legacyTag: "", language: "Spanish" },
          { id: "fr-id", role: "target", name: "French", langCode: null, legacyTag: "fr", language: "French" },
          { id: "es-a", role: "target", name: "Spanish Americas", langCode: null, legacyTag: "es", language: "es" },
          { id: "es-b", role: "target", name: "Spanish Spain", langCode: null, legacyTag: "es", language: "es" },
        ],
        scopes: [
          { userId: "7", kind: "lane", value: "" },
          { userId: "7", kind: "lane", value: "fr" },
          { userId: "7", kind: "lane", value: "fr-id" },
          { userId: "8", kind: "lane", value: "de" },
          { userId: "8", kind: "lane", value: "es" },
          { userId: "8", kind: "file", value: "file-1" },
        ],
        invites: [
          { token: "secret-token", scopeLanes: ["fr", "de"] },
          { token: "open", scopeLanes: null },
        ],
      }),
    ])
    expect(planned.writes.filter((write) => write.table === "project_member_scopes")).toEqual([
      { table: "project_member_scopes", action: "update", projectId: "p1", userId: "7", from: "", to: "def" },
      { table: "project_member_scopes", action: "delete", projectId: "p1", userId: "7", from: "fr" },
    ])
    expect(planned.report.counts.scopes).toMatchObject({ examined: 5, converted: 1, alreadyId: 1, droppedDuplicate: 1, zero: 1, two: 1 })
    expect(planned.report.scopeTags.zero.map((row) => row.value)).toEqual(["de", "de"])
    expect(planned.report.scopeTags.two.map((row) => row.value)).toEqual(["es"])
    expect(planned.report.scopeTags.zero[0]).toMatchObject({ surface: "member", userId: "8", matches: 0 })
    expect(planned.report.scopeTags.zero[1]).toMatchObject({ surface: "invite", userId: null })
    const invite = planned.writes.find((write) => write.table === "project_invites")
    expect(invite).toMatchObject({ scopeLanes: ["fr-id", "de"] })
    expect(JSON.stringify(planned.report)).not.toContain("secret-token")
    expect(planned.report.counts.invites.unscoped).toBe(1)
  })

  it("points a target link at the upstream '' lane and a source link at the source lane", () => {
    const upstream = project({
      id: "up",
      name: "Upstream",
      lanes: [
        { id: "up-src", role: "source", name: "English", langCode: null, legacyTag: null, language: "English" },
        { id: "up-def", role: "target", name: "Spanish", langCode: null, legacyTag: "", language: "Spanish" },
        { id: "up-fr", role: "target", name: "French", langCode: null, legacyTag: "French", language: "French" },
      ],
    })
    const planned = plan([
      upstream,
      project({
        id: "down-target",
        name: "Target link",
        sourceProjectId: "up",
        sourceLinkConsumes: "target",
        sourceLinkLaneId: null,
      }),
      project({
        id: "down-source",
        name: "Source link",
        sourceProjectId: "up",
        sourceLinkConsumes: null,
        sourceLinkLaneId: "up-src",
      }),
      project({
        id: "down-conflict",
        name: "Chosen link",
        sourceProjectId: "up",
        sourceLinkConsumes: "target",
        sourceLinkLaneId: "up-fr",
      }),
      project({
        id: "down-missing",
        name: "Missing upstream",
        sourceProjectId: "gone",
        sourceLinkConsumes: "target",
      }),
    ])
    expect(planned.writes.filter((write) => write.table === "projects")).toEqual([
      { table: "projects", projectId: "down-target", sourceLinkLaneId: "up-def" },
    ])
    expect(planned.report.counts.links).toMatchObject({ examined: 4, filled: 1, already: 1, conflict: 1, unresolved: 1 })
    expect(planned.report.unresolvable.filter((row) => row.rule === "links").map((row) => row.projectId).sort()).toEqual([
      "down-conflict",
      "down-missing",
    ])
  })

  it("assigns audio and back-translations by lane id, then tag, then the '' lane", () => {
    const planned = plan([
      project({
        lanes: [
          { id: "src", role: "source", name: null, langCode: null, legacyTag: null, language: "English" },
          { id: "def", role: "target", name: null, langCode: null, legacyTag: "", language: "Spanish" },
          { id: "fr", role: "target", name: null, langCode: null, legacyTag: "French", language: "French" },
        ],
        audio: [
          { fileId: "f", cellId: "c", audioId: "source-take", role: "source", laneId: null, eventLaneId: "fr", eventTargetLang: "French" },
          { fileId: "f", cellId: "c", audioId: "dub-id", role: "dub", laneId: null, eventLaneId: "fr", eventTargetLang: "French" },
          { fileId: "f", cellId: "c", audioId: "dub-tag", role: "dub", laneId: null, eventLaneId: null, eventTargetLang: "French" },
          { fileId: "f", cellId: "c", audioId: "dub-empty", role: "dub", laneId: null, eventLaneId: null, eventTargetLang: null },
          { fileId: "f", cellId: "c", audioId: "dub-clash", role: "dub", laneId: null, eventLaneId: "fr", eventTargetLang: "" },
          { fileId: "f", cellId: "c", audioId: "dub-kept", role: "dub", laneId: "def", eventLaneId: null, eventTargetLang: "French" },
        ],
        audioValidators: [
          { fileId: "f", cellId: "c", audioId: "dub-tag", username: "ada", laneId: null },
          { fileId: "f", cellId: "c", audioId: "dub-clash", username: "ada", laneId: null },
        ],
        backtranslations: [
          { fileId: "f", cellId: "c", targetEventId: "bt-tag", laneId: null, eventLaneId: null, eventTargetLang: "French", targetCellLaneId: "def", targetEventLaneId: null, targetEventTargetLang: null },
          { fileId: "f", cellId: "c", targetEventId: "bt-cell", laneId: null, eventLaneId: null, eventTargetLang: null, targetCellLaneId: "fr", targetEventLaneId: null, targetEventTargetLang: null },
          { fileId: "f", cellId: "c", targetEventId: "bt-explicit", laneId: null, eventLaneId: null, eventTargetLang: "", targetCellLaneId: "fr", targetEventLaneId: null, targetEventTargetLang: null },
          { fileId: "f", cellId: "c", targetEventId: "bt-missing", laneId: null, eventLaneId: null, eventTargetLang: "German", targetCellLaneId: null, targetEventLaneId: null, targetEventTargetLang: null },
        ],
      }),
    ])
    const audio = Object.fromEntries(
      planned.writes.filter((write) => write.table === "cell_audio").map((write) => [write.audioId, write.laneId]),
    )
    expect(audio).toEqual({
      "source-take": "src",
      "dub-id": "fr",
      "dub-tag": "fr",
      "dub-empty": "def",
    })
    expect(audio["dub-clash"]).toBeUndefined()
    expect(audio["dub-kept"]).toBeUndefined()
    expect(planned.report.counts.audio.byRule).toEqual({
      sourceRole: 1,
      eventLaneId: 1,
      eventTargetLang: 1,
      emptyTag: 1,
    })
    expect(planned.report.counts.audio).toMatchObject({ filled: 4, conflict: 1, unresolved: 1 })
    expect(planned.writes.filter((write) => write.table === "cell_audio_validators")).toEqual([
      {
        table: "cell_audio_validators",
        projectId: "p1",
        fileId: "f",
        cellId: "c",
        audioId: "dub-tag",
        username: "ada",
        laneId: "fr",
      },
    ])
    const bt = Object.fromEntries(
      planned.writes.filter((write) => write.table === "cell_backtranslations").map((write) => [write.targetEventId, write.laneId]),
    )
    expect(bt).toEqual({ "bt-tag": "fr", "bt-cell": "fr", "bt-explicit": "def" })
    expect(planned.report.counts.backtranslations.byRule).toMatchObject({
      eventTargetLang: 1,
      targetEvent: 1,
      emptyTag: 1,
    })
    expect(planned.report.unresolvable.some((row) => row.rule === "backtranslations" && row.key.endsWith("bt-missing"))).toBe(true)
  })

  it("stamps a missing rendering laneId onto the '' lane and leaves the others", () => {
    const withBridge = plan([
      project({
        lanes: [
          { id: "src", role: "source", name: null, langCode: null, legacyTag: null, language: "English" },
          { id: "def", role: "target", name: null, langCode: null, legacyTag: "", language: "Spanish" },
          { id: "fr", role: "target", name: null, langCode: null, legacyTag: "French", language: "French" },
        ],
        concepts: [
          {
            conceptId: "term-1",
            renderings: [{ text: "casa" }, { text: "maison", laneId: "fr" }],
          },
        ],
      }),
    ])
    const write = withBridge.writes.find((item) => item.table === "concepts")
    expect(write).toMatchObject({
      conceptId: "term-1",
      renderings: [
        { text: "casa", laneId: "def" },
        { text: "maison", laneId: "fr" },
      ],
    })
    expect(withBridge.report.counts.concepts).toMatchObject({ restamped: 1, already: 0 })

    const withoutBridge = plan([
      project({
        lanes: [{ id: "src", role: "source", name: null, langCode: null, legacyTag: null, language: "English" }],
        concepts: [{ conceptId: "term-2", renderings: [{ text: "casa" }] }],
      }),
    ])
    expect(withoutBridge.writes.some((item) => item.table === "concepts")).toBe(false)
    expect(withoutBridge.report.unresolvable.map((row) => row.reason)).toContain(
      "rendering has no laneId and the project has no target lane with legacy_tag ''",
    )
  })

  it("counts files whose source totals are not on the source lane", () => {
    const planned = plan([
      project({
        lanes: [
          { id: "src", role: "source", name: null, langCode: null, legacyTag: null, language: "English" },
          { id: "def", role: "target", name: null, langCode: null, legacyTag: "", language: "Spanish" },
        ],
        files: [{ id: "f1" }, { id: "f2" }],
        progress: [
          { fileId: "f1", scope: "file", sectionKey: "", laneId: "def", targetLang: "" },
          { fileId: "f2", scope: "file", sectionKey: "", laneId: "src", targetLang: "" },
          { fileId: "f1", scope: "file", sectionKey: "", laneId: "missing", targetLang: "" },
        ],
      }),
    ])
    expect(planned.report.counts.progress).toEqual({ filesToRecompute: 2, filesMissingSourceRow: 1, orphanRows: 1 })
    expect(planned.progressFiles.map((file) => file.fileId)).toEqual(["f1", "f2"])
    expect(planned.report.unresolvable.some((row) => row.rule === "progress" && row.key.includes("missing"))).toBe(true)
  })

  it("is idempotent after the planned writes", () => {
    const snapshot: LaneBatchSnapshot = {
      projects: [
        project({
          sourceProjectId: "up",
          sourceLinkConsumes: "target",
          lanes: [
            { id: "src", role: "source", name: "Source", langCode: "en", legacyTag: null, language: null },
            { id: "def", role: "target", name: "Spanish", langCode: "es", legacyTag: "", language: null },
            { id: "a3f09c1e", role: "target", name: "German", langCode: "de", legacyTag: "a3f09c1e", language: null },
          ],
          scopes: [{ userId: "7", kind: "lane", value: "Spanish" }],
          invites: [{ token: "tok", scopeLanes: [""] }],
          audio: [
            { fileId: "f", cellId: "c", audioId: "a", role: "dub", laneId: null, eventLaneId: null, eventTargetLang: null },
          ],
          audioValidators: [{ fileId: "f", cellId: "c", audioId: "a", username: "ada", laneId: null }],
          backtranslations: [
            {
              fileId: "f",
              cellId: "c",
              targetEventId: "t",
              laneId: null,
              eventLaneId: null,
              eventTargetLang: null,
              targetCellLaneId: null,
              targetEventLaneId: null,
              targetEventTargetLang: null,
            },
          ],
          concepts: [{ conceptId: "term-1", renderings: [{ text: "casa" }] }],
          files: [{ id: "f" }],
        }),
        project({
          id: "up",
          name: "Upstream",
          lanes: [
            { id: "up-src", role: "source", name: null, langCode: null, legacyTag: null, language: "English" },
            { id: "up-def", role: "target", name: null, langCode: null, legacyTag: "", language: "Spanish" },
          ],
        }),
      ],
    }
    const first = planLaneBatch(snapshot)
    expect(first.writes.length).toBeGreaterThan(0)
    const second = planLaneBatch(after(snapshot, first))
    expect(second.writes).toEqual([])
    expect(second.report.counts.progress.filesMissingSourceRow).toBe(0)
    expect(second.report.guessedLanguages).toEqual([])
    const source = snapshot.projects[0]!.lanes[0]!
    const again = after(snapshot, first).projects[0]!.lanes.find((lane) => lane.id === source.id)
    expect(again?.legacyTag).toBe(source.legacyTag)
  })

  it("plans one project without rewriting its upstream", () => {
    const planned = plan(
      [
        project({
          id: "up",
          lanes: [
            { id: "up-src", role: "source", name: "English", langCode: "en", legacyTag: null, language: null },
            { id: "up-def", role: "target", name: null, langCode: null, legacyTag: "", language: "Spanish" },
          ],
        }),
        project({ id: "down", sourceProjectId: "up", sourceLinkConsumes: "target" }),
      ],
      "down",
    )
    expect(planned.writes).toEqual([{ table: "projects", projectId: "down", sourceLinkLaneId: "up-def" }])
  })

  it("uses the latest audio attach as the take's lane claim", () => {
    const chosen = selectAudioLaneEvent([
      { id: "a", kind: "cell.audio.attach", serverSeq: 1, laneId: null, targetLang: "" },
      { id: "b", kind: "cell.audio.trim", serverSeq: 3, laneId: "fr", targetLang: "French" },
      { id: "c", kind: "cell.audio.attach", serverSeq: 2, laneId: "def", targetLang: "" },
    ])
    expect(chosen?.id).toBe("c")
    expect(selectAudioLaneEvent([])).toBeNull()
  })

  it("renders the report sections the conductor reviews", () => {
    const planned = plan([
      project({
        lanes: [
          { id: "a3f09c1e", role: "target", name: "German", langCode: null, legacyTag: "a3f09c1e", language: null },
        ],
        scopes: [{ userId: "7", kind: "lane", value: "nope" }],
      }),
    ])
    const markdown = renderLaneBatchReport(planned.report)
    expect(markdown).toContain("## Counts")
    expect(markdown).toContain("## Guessed lane languages")
    expect(markdown).toContain(GUESSED_LANE_LANGUAGE_REASON)
    expect(markdown).toContain("## Unresolvable rows")
    expect(markdown).toContain("## AQU-1585 name/code disagreements")
    expect(markdown).toContain("## AQU-1585 duplicate names")
    expect(markdown).toContain("## Scope tags matching zero lanes")
    expect(markdown).toContain("## Scope tags matching two lanes")
    expect(planned.report.scopeTags.zero).toHaveLength(1)
    expect(planned.report.scopeTags.two).toEqual([])
    const json = JSON.parse(JSON.stringify(planned.report)) as typeof planned.report
    expect(json.counts.lanes.guessed).toBe(1)
    expect(json.unresolvable[0]?.reason).toBe("scope tag matches zero lanes")
  })
})

describe("lane batch apply gate", () => {
  const ready = {
    laneLanguage: true,
    laneNameNullable: true,
    sourceLinkLaneId: true,
    audioLaneId: true,
    audioValidatorLaneId: true,
    backtranslationLaneId: true,
  }

  it("refuses apply until 0138 and 0152 are applied", () => {
    const refusal = laneBatchApplyRefusal(["0138_project_source_link_lane_id.sql"], ready)
    expect(refusal).toContain("0138_project_source_link_lane_id.sql")
    expect(refusal).toContain("0152_lane_language.sql")
    expect(laneBatchApplyRefusal(["0138_project_source_link_lane_id.sql", "0152_lane_language.sql"], {
      ...ready,
      laneNameNullable: false,
    })).toContain("lanes.name is still NOT NULL")
    expect(laneBatchApplyRefusal(["0138_project_source_link_lane_id.sql", "0152_lane_language.sql"], ready)).toBeNull()
  })

  it("opens a dry run with the read-only session option and apply without it", () => {
    expect(laneBatchClientConfig("postgresql://local/aquilla", true)).toEqual({
      connectionString: "postgresql://local/aquilla",
      options: LANE_BATCH_READ_ONLY_OPTIONS,
    })
    expect(LANE_BATCH_READ_ONLY_OPTIONS).toBe("-c default_transaction_read_only=on")
    expect(laneBatchClientConfig("postgresql://local/aquilla", false)).toEqual({
      connectionString: "postgresql://local/aquilla",
    })
  })

  it("never assigns legacy_tag, rewrites events, or deletes lanes", () => {
    for (const sql of Object.values(LANE_BATCH_SQL)) {
      expect(sql.toLowerCase()).not.toMatch(/legacy_tag\s*=/)
      expect(sql.toLowerCase()).not.toMatch(/update\s+events/)
      expect(sql.toLowerCase()).not.toMatch(/delete\s+from\s+lanes/)
    }
    expect(LANE_BATCH_SQL.deleteScope.toLowerCase()).toContain("delete from project_member_scopes")
    expect(LANE_BATCH_SQL.updateLink).toContain("source_link_lane_id IS NULL")
    expect(LANE_BATCH_SQL.updateAudio).toContain("lane_id IS NULL")
  })
})
