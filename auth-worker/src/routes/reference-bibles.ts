// AQU-1573: the reference Bibles installed on this server, for the SPA.
//
// Mounted at /api/v2/reference-bibles in src/index.ts.
//
//   GET  /                          { versions: ReferenceBibleSummary[] }
//        The Settings card's "Reference Bible" choices.
//   POST /:versionId/passages       { refs: string[] } → { version, passages, unresolved }
//        The verses of canonical references ("ISA 40:25", "JHN 3:16-18") in
//        one Bible. The copilot's drafting block and the live quote check read
//        through this, one batched request per open file.
//
// Any signed-in user: the built-in texts are public domain and carry nothing
// project-specific, so there is no project to gate on. Partner uploads (later)
// will be org-scoped, and that check belongs in db/shared/reference-bible.ts,
// which already lists only built-in versions (org_id IS NULL).
//
// The Agent API's discovery read is the sync-worker twin
// (sync-worker/src/external/reference-bibles-route.ts); both read the same
// shared module so they can never list different Bibles.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import {
  MAX_REFERENCES_PER_LOOKUP,
  getReferenceBible,
  listReferenceBibles,
  lookupPassages,
} from "../../../db/shared/reference-bible"

const referenceBibles = new Hono<AuthHonoEnv>()

referenceBibles.get("/", authMiddleware, async (c) => {
  const versions = await listReferenceBibles(c.env.AQUILLA_PG)
  return c.json({ versions })
})

const passagesSchema = z.object({
  // Canonical wire form only ("ISA 40:25", "JHN 3:16-4:2"); a malformed one
  // comes back in `unresolved` rather than failing the whole batch.
  refs: z.array(z.string().min(1).max(64)).max(MAX_REFERENCES_PER_LOOKUP),
})

referenceBibles.post(
  "/:versionId/passages",
  authMiddleware,
  zValidator("json", passagesSchema),
  async (c) => {
    const versionId = c.req.param("versionId") ?? ""
    const version = await getReferenceBible(c.env.AQUILLA_PG, versionId)
    if (!version) return c.json({ error: `reference Bible "${versionId}" is not installed` }, 404)
    const { refs } = c.req.valid("json")
    const { passages, unresolved } = await lookupPassages(c.env.AQUILLA_PG, version.id, refs)
    return c.json({ version, passages, unresolved })
  },
)

export default referenceBibles
