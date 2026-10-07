// POST /:projectId/contextual/bible-check — "Check with Bible data" (AQU-1690).
//
// Checks one file's TRANSLATED cells against the Bible Knowledge Pack: the
// bkp: expectations in code, then the Jev questions (shadow or active, as for
// autopilot drafts), and raises the Language-profile fact questions the file
// needs (decision cards, runId null). It never writes text.
//
// MAINTAINER: it spends Jev calls (purpose bible-qa, its own cap) and raises
// project decision cards, and its answer includes shadow-mode judgments,
// which are for maintainers only. Bounded per call (MAX_CHECK_CELLS); pass
// `startAfter` to continue. Sibling router, same base as routes/contextual.ts.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { errorJson, requireAutopilotReleased, requireRole } from "./_contextual-helpers"
import { selectCellPairs } from "../lib/agent/tools/select-cells"
import { loadProjectContext } from "../lib/contextual/project-context"
import { prepareBibleWave } from "../lib/contextual/bible-run"
import { makeBibleTickDeps } from "../lib/contextual/bible-deps"
import { raiseBibleFactQuestions } from "../lib/contextual/bible-fact-questions"
import { checkTranslatedCells } from "../lib/contextual/bible-check-mode"
import { makeCostMeter } from "../lib/cost-meter"

const bibleCheck = new Hono<AuthHonoEnv>()

const checkSchema = z.object({
  fileId: z.string().min(1).max(512),
  targetLang: z.string().max(64).optional(),
  startAfter: z.string().min(1).max(512).optional(),
})

bibleCheck.post(
  "/:projectId/contextual/bible-check",
  authMiddleware,
  zValidator("json", checkSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.MAINTAINER)
    if (!gate.ok) return gate.res
    const released = await requireAutopilotReleased(c, projectId)
    if (!released.ok) return released.res
    const body = c.req.valid("json")
    const db = c.env.AQUILLA_PG

    // Jev calls are metered like a run's (agent_cost_meter, COST_METER=1); flushed before the answer.
    const meter = makeCostMeter(c.env, db)
    const deps = makeBibleTickDeps(c.env, db, { projectId, runId: `bible-check:${crypto.randomUUID()}` }, { meter })
    const flags = await deps.flags()
    if (!flags.autopilot || !flags.checks) {
      const { body: err, status } = errorJson(
        "bible_data_off",
        "Turn on Bible data, Use Bible data in autopilot, and Bible data checks to check with Bible data.",
        409,
      )
      return c.json(err, status)
    }

    const [ctx, pairs] = await Promise.all([
      loadProjectContext(db, projectId),
      selectCellPairs(db, projectId, { fileId: body.fileId, targetLang: body.targetLang ?? "" }),
    ])
    // The wave's own loader: a layer whose insides do not compile is `invalid`, not a 500.
    const bible = await prepareBibleWave(
      { flags: async () => flags, loadPack: deps.loadPack },
      {
        pairs,
        profile: ctx.languageProfile,
        concepts: ctx.concepts,
        facts: ctx.projectFacts,
        sourceLanguage: ctx.sourceLanguage,
        multiLane: ctx.multiLane,
      },
    )
    if (bible.state === "off") {
      const { body: err, status } = errorJson("no_bible_refs", "This file has no verse references to check.", 422)
      return c.json(err, status)
    }
    if (bible.state === "unavailable") {
      const { body: err, status } = errorJson("bible_data_unavailable", `Bible data did not load (${bible.reason}).`, 503)
      return c.json(err, status)
    }

    const result = await checkTranslatedCells({
      pairs,
      data: bible.data,
      ...(deps.judge ? { judge: deps.judge } : {}),
      ...(body.startAfter ? { startAfter: body.startAfter } : {}),
    })
    const factQuestions = await raiseBibleFactQuestions(db, {
      projectId,
      fileId: body.fileId,
      data: bible.data,
      raised: new Set(),
    })
    await meter.flush()
    return c.json({ ...result, factQuestions })
  },
)

export default bibleCheck
