// AQU-1573: the "Reference Bible quotes" check inside emit staging. The
// in-app agent must hear, in its verdict block, that a staged sermon draft
// changed a quoted verse or translated a visibly quoted verse fresh, so it can
// redraft from the lane's Bible before a human reads the proposal. A correct
// quote, a mere mention, and a lane with no Bible stay silent about quotes. A
// draft that leaves out a cited reference's numbers is flagged on any lane.

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { stageEvents, type EmitStageContext } from "../lib/agent/emit-stage"
import { AliasMap } from "../lib/agent/compress"
import { installFixtureReferenceBibles } from "../../../db/shared/reference-bible-fixtures"
import { lookupPassages } from "../../../db/shared/reference-bible"

const PROJECT = "77777777-7777-4777-8777-777777777777"
const FILE = "88888888-8888-4888-8888-888888888888"
const cellId = (n: number) => `99999999-9999-4999-8999-${String(n).padStart(12, "0")}`

const SOURCES = [
  'Romans 8:28: "And we know that in all things God works for the good of those who love him."',
  'The psalmist writes, "The Lord is my shepherd, I lack nothing" (Ps 23:1).',
  "Later we'll look at Philippians 4:13.",
]

function ctx(lane = ""): EmitStageContext {
  return { runId: "run-1", projectId: PROJECT, roleLevel: 400, fileId: FILE, lane, aliases: new AliasMap() }
}

async function verse(versionId: string, canonical: string): Promise<string> {
  const { passages } = await lookupPassages(env.AQUILLA_PG, versionId, [canonical])
  return passages[0].verses.map((v) => v.text).join(" ")
}

function commit(n: number, value: string) {
  return { kind: "target.cell.commit", fileId: FILE, cellId: cellId(n), payload: { value } }
}

beforeEach(async () => {
  await installFixtureReferenceBibles(env.AQUILLA_PG)
  for (const [i, source] of SOURCES.entries()) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, sequence_index, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
    )
      .bind(PROJECT, FILE, cellId(i + 1), source, i, crypto.randomUUID())
      .run()
  }
  await env.AQUILLA_PG.prepare(`INSERT INTO project_settings (project_id, settings) VALUES (?, ?)`)
    .bind(
      PROJECT,
      JSON.stringify({
        sourceLanguage: "English",
        targetLanguage: "Arabic",
        targetLanes: ["en"],
        bibleResourcesEnabled: false,
        referenceBibleVersions: { "": "arb-vandyck" },
      }),
    )
    .run()
})

describe("emit staging — reference Bible quote lint (AQU-1573)", () => {
  it("says nothing for an exact quote and a mere mention", async () => {
    const rom = await verse("arb-vandyck", "ROM 8:28")
    const out = await stageEvents(env.AQUILLA_PG, [commit(1, `رومية 8: 28: «${rom}»`), commit(3, "سننظر لاحقًا في فيلبي 4: 13.")], ctx())
    expect(out.proposal?.events).toHaveLength(2)
    expect(out.modelVerdictBlock).not.toContain("NEEDS REVIEW")
  })

  it("flags a changed word and hands back the Bible's wording", async () => {
    const rom = await verse("arb-vandyck", "ROM 8:28")
    const changed = rom.replace("لِلْخَيْرِ", "لِلصَّلَاحِ")
    expect(changed).not.toBe(rom)
    const out = await stageEvents(env.AQUILLA_PG, [commit(1, `رومية 8: 28: «${changed}»`)], ctx())
    // Still staged: the check is a warning, never a block.
    expect(out.proposal?.events).toHaveLength(1)
    expect(out.modelVerdictBlock).toContain(
      `NEEDS REVIEW #1: Scripture quote Romans 8:28 does not match Van Dyck word for word — copy the quoted words exactly from it: "${rom}"`,
    )
    expect(out.modelVerdictBlock).toContain("Fix the NEEDS REVIEW drafts and re-emit them")
  })

  it("flags a visibly quoted verse translated fresh", async () => {
    const out = await stageEvents(env.AQUILLA_PG, [commit(2, "يكتب المرنم: «الرب هو راعيّ، لن أحتاج إلى شيء» (مز 23: 1).")], ctx())
    expect(out.modelVerdictBlock).toContain(
      "NEEDS REVIEW #1: the source quotes Psalm 23:1 but the draft does not use the Van Dyck wording",
    )
    expect(out.modelVerdictBlock).toContain(await verse("arb-vandyck", "PSA 23:1"))
  })

  it("stays silent about quotes on a lane with no reference Bible", async () => {
    const rom = await verse("arb-vandyck", "ROM 8:28")
    const out = await stageEvents(env.AQUILLA_PG, [commit(1, `رومية 8: 28: «${rom.replace("لِلْخَيْرِ", "لِلصَّلَاحِ")}»`)], ctx("en"))
    expect(out.proposal?.events).toHaveLength(1)
    expect(out.modelVerdictBlock).not.toContain("NEEDS REVIEW")
  })

  it("flags a draft that leaves out the cited reference, with or without a Bible", async () => {
    const rom = await verse("arb-vandyck", "ROM 8:28")
    const line = "NEEDS REVIEW #1: the source cites Romans 8:28 but the draft leaves out the reference — keep its chapter and verse numbers in the translation"
    const withBible = await stageEvents(env.AQUILLA_PG, [commit(1, `«${rom}»`)], ctx())
    expect(withBible.proposal?.events).toHaveLength(1)
    expect(withBible.modelVerdictBlock).toContain(line)
    expect(withBible.modelVerdictBlock).not.toContain("word for word")
    const noBible = await stageEvents(env.AQUILLA_PG, [commit(1, `«${rom}»`)], ctx("en"))
    expect(noBible.modelVerdictBlock).toContain(line)
    // Arabic-Indic digits keep the reference.
    const kept = await stageEvents(env.AQUILLA_PG, [commit(1, `رومية ٨: ٢٨: «${rom}»`)], ctx())
    expect(kept.modelVerdictBlock).not.toContain("NEEDS REVIEW")
  })
})
