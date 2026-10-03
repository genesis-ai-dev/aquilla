/**
 * AQU-1573: seed the reference Bible demo project on a running dev stack.
 *
 *   npx tsx scripts/dev-seed-reference-bible.ts
 *     [--identity http://127.0.0.1:8788] [--sync http://127.0.0.1:8789]
 *     [--web http://localhost:5173] [--no-token]
 *
 * Builds "Sermon demo — reference Bible" in the dev org, signed in as `dev`:
 * source English, default lane Arabic quoting Van Dyck, an extra lane "Plain
 * English" quoting the KJV, Bible resources off, and one sermon file of twelve
 * rows that cover a correct quote, a quote typed without vowel marks, a
 * changed word, a fresh translation, a mere mention, an allusion, and blank
 * rows to draft. The rows and what each should show live in
 * scripts/reference-bible-demo.ts (unit-tested); every quoted draft is derived
 * from the committed Bible text, so it cannot drift from what the stack loaded.
 *
 * Re-runnable. Ids are deterministic, so a second run lands on the same
 * project, lanes and file; settings and every seeded target are put back to
 * the demo state (anything typed into a target since is overwritten by a new
 * commit, so it stays in the cell's history). A deleted demo file is stepped
 * past, never resurrected: the next run seeds a fresh copy.
 *
 * Not run on boot, on purpose: other developers' stacks should not grow a demo
 * project they never asked for. Over HTTP only, like scripts/i18n-shots/seed.ts,
 * so it exercises the same routes the app does.
 *
 * If the stack has no reference Bibles yet, it runs the loader
 * (scripts/reference-bibles.ts load --if-missing) against AQUILLA_DATABASE_URL,
 * else LOCAL_PG_URL, else the dev stack's default database, and stops with a
 * plain message if they still are not there. Unless --no-token is passed it
 * also mints an Agent API token for `dev` (revoking the previous demo token)
 * and prints ready-to-paste curl lines; the token is printed once and never
 * written anywhere.
 */

import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { v7 as uuidv7 } from "uuid"
import {
  DEMO_BIBLE_IDS,
  DEMO_FILE_NAME,
  DEMO_PROJECT_ID,
  DEMO_PROJECT_NAME,
  DEMO_SETTINGS,
  ENGLISH_LANE,
  MAX_DEMO_GENERATIONS,
  buildDemoRows,
  demoFileEventId,
  demoFileId,
  demoLanes,
  seededTargetEventId,
  type DemoRow,
} from "./reference-bible-demo"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_LOCAL_PG_URL = "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"
const TOKEN_NAME = "Reference Bible demo (dev seed)"

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const IDENTITY = (flag("--identity") ?? process.env.DEV_SEED_IDENTITY_BASE ?? "http://127.0.0.1:8788").replace(/\/$/, "")
const SYNC = (flag("--sync") ?? process.env.DEV_SEED_SYNC_BASE ?? "http://127.0.0.1:8789").replace(/\/$/, "")
const WEB = (flag("--web") ?? process.env.DEV_SEED_WEB_BASE ?? "http://localhost:5173").replace(/\/$/, "")

/** A seeding failure with a sentence a tester can act on. */
class SeedError extends Error {}

async function call<T>(
  what: string,
  url: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch (err) {
    throw new SeedError(
      `${what}: cannot reach ${new URL(url).origin} (${err instanceof Error ? err.message : String(err)}). ` +
        "Is the dev stack running? Pass --identity/--sync for a stack on other ports.",
    )
  }
  const text = await res.text()
  if (!res.ok) throw new SeedError(`${what} failed: HTTP ${res.status} ${text.slice(0, 400)}`)
  return (text ? JSON.parse(text) : {}) as T
}

// ── Sign-in and the Bibles ───────────────────────────────────────────────────

interface Session { jwt: string; orgId: number; username: string }

async function signIn(): Promise<Session> {
  const body = await call<{ access_token: string; org: { id: number }; username: string }>(
    "dev login",
    `${IDENTITY}/__dev__/login`,
    { method: "POST" },
  )
  return { jwt: body.access_token, orgId: body.org.id, username: body.username }
}

async function installedBibles(jwt: string): Promise<string[]> {
  const body = await call<{ versions: { id: string }[] }>(
    "list reference Bibles",
    `${IDENTITY}/api/v2/reference-bibles`,
    { token: jwt },
  )
  return body.versions.map((v) => v.id)
}

async function ensureBibles(jwt: string): Promise<void> {
  const missing = async () => {
    const have = new Set(await installedBibles(jwt))
    return DEMO_BIBLE_IDS.filter((id) => !have.has(id))
  }
  let lacking = await missing()
  if (lacking.length === 0) return
  const databaseUrl = process.env.AQUILLA_DATABASE_URL || process.env.LOCAL_PG_URL || DEFAULT_LOCAL_PG_URL
  console.log(`reference Bibles missing on this stack (${lacking.join(", ")}): loading them into ${redact(databaseUrl)} …`)
  const result = spawnSync("npx", ["tsx", "scripts/reference-bibles.ts", "load", "--if-missing"], {
    cwd: REPO_ROOT,
    env: { ...process.env, AQUILLA_DATABASE_URL: databaseUrl },
    stdio: "inherit",
  })
  lacking = await missing()
  if (lacking.length > 0) {
    throw new SeedError(
      `the stack still has no ${lacking.join(", ")} after the loader ran (exit ${result.status ?? "signal"}). ` +
        "Point AQUILLA_DATABASE_URL (or LOCAL_PG_URL) at the database this stack uses and run again, " +
        "or load by hand: AQUILLA_DATABASE_URL=… npx tsx scripts/reference-bibles.ts load",
    )
  }
}

function redact(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]*@/, "//$1:***@")
}

// ── Project, settings, lanes ─────────────────────────────────────────────────

interface SettingsRead {
  settings?: Record<string, unknown>
  version?: number
  lanes?: { id: string; role: string; name: string; legacyTag: string | null; archivedAt: string | null }[]
}

const settingsUrl = `${IDENTITY}/api/v2/projects/${DEMO_PROJECT_ID}/settings`

async function readSettings(jwt: string): Promise<SettingsRead> {
  return call<SettingsRead>("read project settings", settingsUrl, { token: jwt })
}

/** Merge keys into the settings blob at its live version (one retry on a race). */
async function writeSettings(jwt: string, keys: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const current = await readSettings(jwt)
    try {
      await call("write project settings", settingsUrl, {
        method: "PUT",
        token: jwt,
        body: { settings: { ...(current.settings ?? {}), ...keys }, ifMatchVersion: current.version ?? 0 },
      })
      return
    } catch (err) {
      if (attempt === 0 && err instanceof SeedError && /HTTP 409/.test(err.message)) continue
      throw err
    }
  }
}

async function ensureProject(session: Session): Promise<void> {
  await call("create the demo project", `${IDENTITY}/api/v2/projects`, {
    token: session.jwt,
    body: { id: DEMO_PROJECT_ID, name: DEMO_PROJECT_NAME, orgId: session.orgId },
  })
  await writeSettings(session.jwt, {
    sourceLanguage: DEMO_SETTINGS.sourceLanguage,
    targetLanguage: DEMO_SETTINGS.targetLanguage,
    bibleResourcesEnabled: DEMO_SETTINGS.bibleResourcesEnabled,
    translationBrief: {
      parameters: {
        purpose: "Sermon translation for Arabic-speaking churches. Quote Scripture from the Van Dyck Bible.",
      },
    },
  })

  // The Plain English lane: created once, brought back if it was archived.
  const lanes = (await readSettings(session.jwt)).lanes ?? []
  const english = lanes.find((l) => l.role === "target" && (l.legacyTag ?? "").toLowerCase() === ENGLISH_LANE.tag)
  if (!english) {
    await call("add the Plain English lane", `${IDENTITY}/api/v2/projects/${DEMO_PROJECT_ID}/lanes`, {
      token: session.jwt,
      body: { name: ENGLISH_LANE.name, language: ENGLISH_LANE.tag },
    })
  } else if (english.archivedAt) {
    await call("restore the Plain English lane", `${IDENTITY}/api/v2/projects/${DEMO_PROJECT_ID}/lanes/${english.id}/archive`, {
      token: session.jwt,
      body: { archived: false },
    })
  }
  const after = (await readSettings(session.jwt)).lanes ?? []
  if (!after.some((l) => l.role === "target" && l.legacyTag === ENGLISH_LANE.tag && !l.archivedAt)) {
    throw new SeedError(
      `the Plain English lane did not come out with the tag "${ENGLISH_LANE.tag}" ` +
        `(lanes: ${after.map((l) => `${l.name}=${l.legacyTag ?? "∅"}`).join(", ")}). ` +
        "Rename or remove the conflicting lane in Settings → Languages and run again.",
    )
  }

  // Last, so the lane it names exists: one Bible per language.
  await writeSettings(session.jwt, { referenceBibleVersions: { ...DEMO_SETTINGS.referenceBibleVersions } })
}

// ── The file ─────────────────────────────────────────────────────────────────

interface FileSummary { fileId: string }
interface CellRow { cellId: string; side: "source" | "target"; targetLang: string; value: string; eventId: string }

async function syncToken(jwt: string, fileId: string): Promise<string> {
  const body = await call<{ token: string }>("mint a sync token", `${IDENTITY}/api/v2/sync-token`, {
    token: jwt,
    body: { projectId: DEMO_PROJECT_ID, fileId },
  })
  return body.token
}

/** The first generation of the demo file that is not deleted (it may not exist yet). */
async function chooseGeneration(jwt: string): Promise<{ generation: number; exists: boolean }> {
  const token = await syncToken(jwt, demoFileId(0))
  const list = async (trash: boolean) =>
    (
      await call<{ files: FileSummary[] }>(
        trash ? "list the project's deleted files" : "list the project's files",
        `${SYNC}/api/v1/projects/${DEMO_PROJECT_ID}/files${trash ? "?trash=1" : ""}`,
        { token },
      )
    ).files.map((f) => f.fileId)
  const active = new Set(await list(false))
  const deleted = new Set(await list(true))
  for (let generation = 0; generation < MAX_DEMO_GENERATIONS; generation++) {
    const fileId = demoFileId(generation)
    if (active.has(fileId)) return { generation, exists: true }
    if (!deleted.has(fileId)) return { generation, exists: false }
  }
  throw new SeedError(
    `the demo file has been deleted ${MAX_DEMO_GENERATIONS} times in this database. ` +
      "Delete the project “Sermon demo — reference Bible” and run again.",
  )
}

async function importFile(token: string, generation: number, rows: readonly DemoRow[]): Promise<void> {
  const fileId = demoFileId(generation)
  const cells = rows.map((row, i) => ({
    id: row.sourceEventId,
    cellId: row.cellId,
    anchorCellId: i === 0 ? null : rows[i - 1].cellId,
    value: row.source,
    type: row.type,
    sequenceIndex: i,
    paragraphStart: true,
    metadata: { paragraphStart: true },
  }))
  const targets = rows.flatMap((row) =>
    Object.entries(row.targets)
      .filter(([, value]) => value !== "")
      .map(([lane, value]) => ({
        id: seededTargetEventId(row, lane),
        cellId: row.cellId,
        parentId: row.sourceEventId,
        value,
        ...(lane ? { targetLang: lane } : {}),
      })),
  )
  await call("import the demo file", `${SYNC}/import`, {
    token,
    body: {
      projectId: DEMO_PROJECT_ID,
      fileId,
      file: {
        id: demoFileEventId(generation),
        name: DEMO_FILE_NAME,
        fileType: "md",
        role: "source",
        kind: "md",
        importFormat: "md",
        parserVersion: "reference-bible-demo-seed-v1",
        sourceLanguage: DEMO_SETTINGS.sourceLanguage,
        targetLanguage: DEMO_SETTINGS.targetLanguage,
        sourceTextDirection: "ltr",
        // The default lane is Arabic; the Plain English lane still reads
        // left to right because direction is detected per cell.
        targetTextDirection: "rtl",
        orderedBy: "sequence",
      },
      cells,
      targets,
      clientTs: Date.now(),
    },
  })
  await call("finish the import", `${SYNC}/import`, {
    token,
    body: { projectId: DEMO_PROJECT_ID, fileId, cells: [], complete: true },
  })
}

async function readCells(token: string, fileId: string): Promise<CellRow[]> {
  const { cells } = await call<{ cells: CellRow[] }>(
    "read the demo file's cells",
    `${SYNC}/api/v1/projects/${DEMO_PROJECT_ID}/files/${fileId}/cells?limit=500`,
    { token },
  )
  return cells
}

/** Put every seeded target back to the demo text, as ordinary commits. */
async function resetTargets(session: Session, token: string, generation: number, rows: readonly DemoRow[]): Promise<number> {
  const fileId = demoFileId(generation)
  const cells = await readCells(token, fileId)
  const events: unknown[] = []
  for (const row of rows) {
    const source = cells.find((c) => c.cellId === row.cellId && c.side === "source")
    if (!source) {
      throw new SeedError(
        `row ${row.n} ("${row.source.slice(0, 40)}…") is missing from the demo file. ` +
          "Delete the demo file in the app and run again; the next run seeds a fresh copy.",
      )
    }
    if (source.value !== row.source) {
      throw new SeedError(
        `row ${row.n}'s source text was edited in the app ("${source.value.slice(0, 60)}"). ` +
          "Delete the demo file in the app and run again; the next run seeds a fresh copy.",
      )
    }
    for (const lane of demoLanes(rows)) {
      const want = row.targets[lane] ?? ""
      const current = cells.find((c) => c.cellId === row.cellId && c.side === "target" && (c.targetLang ?? "") === lane)
      if ((current?.value ?? "") === want) continue
      events.push({
        id: uuidv7(),
        schemaVersion: 1,
        kind: "target.cell.commit",
        projectId: DEMO_PROJECT_ID,
        fileId,
        cellId: row.cellId,
        parentId: current?.eventId ?? source.eventId,
        author: session.username,
        payload: { value: want, sourceEventId: source.eventId, ...(lane ? { targetLang: lane } : {}) },
        clientTs: Date.now(),
      })
    }
  }
  if (events.length === 0) return 0
  const result = await call<{ stale?: unknown[]; rejected?: unknown[] }>("reset the demo drafts", `${SYNC}/events`, {
    token,
    body: { events },
  })
  if (result.rejected?.length || result.stale?.length) {
    throw new SeedError(
      `resetting the demo drafts was refused: ${JSON.stringify({ rejected: result.rejected, stale: result.stale }).slice(0, 400)}. ` +
        "Someone may be editing the demo file right now; run again in a moment.",
    )
  }
  return events.length
}

/** Read the file back and prove every row holds the demo text in every lane. */
async function verify(token: string, generation: number, rows: readonly DemoRow[]): Promise<void> {
  const cells = await readCells(token, demoFileId(generation))
  const wrong: string[] = []
  for (const row of rows) {
    for (const lane of demoLanes(rows)) {
      const want = row.targets[lane] ?? ""
      const got = cells.find((c) => c.cellId === row.cellId && c.side === "target" && (c.targetLang ?? "") === lane)?.value ?? ""
      if (got !== want) wrong.push(`row ${row.n} ${lane || "Arabic"}`)
    }
  }
  if (wrong.length > 0) {
    throw new SeedError(`after seeding, these targets still do not hold the demo text: ${wrong.join(", ")}`)
  }
}

// ── Agent API token ──────────────────────────────────────────────────────────

async function mintDemoToken(jwt: string): Promise<string> {
  const { credentials } = await call<{ credentials: { id: string; name: string; revokedAt: string | null }[] }>(
    "list API tokens",
    `${IDENTITY}/api/v2/credentials`,
    { token: jwt },
  )
  for (const old of credentials.filter((c) => c.name === TOKEN_NAME && !c.revokedAt)) {
    await call("revoke the previous demo token", `${IDENTITY}/api/v2/credentials/${old.id}`, { method: "DELETE", token: jwt })
  }
  const minted = await call<{ token: string }>("mint an API token", `${IDENTITY}/api/v2/credentials`, {
    token: jwt,
    body: { name: TOKEN_NAME, mode: "ask" },
  })
  return minted.token
}

function curlLines(apiToken: string, settingsVersion: number, rows: readonly DemoRow[], fileId: string): string {
  const auth = `-H "Authorization: Bearer ${apiToken}"`
  const json = `-H "Content-Type: application/json"`
  const ext = `${SYNC}/api/v1/external`
  const patch = (value: unknown) =>
    `curl -s -X POST ${auth} ${json} ${ext}/projects/${DEMO_PROJECT_ID}/changesets -d '${JSON.stringify({
      commands: [{ kind: "PatchSettings", projectId: DEMO_PROJECT_ID, ops: [{ key: "referenceBibleVersions", value }], ifMatchVersion: settingsVersion }],
    })}'`
  const isaiah = rows[2]
  return [
    "# The installed Bibles (both should be listed):",
    `curl -s ${auth} ${ext}/reference-bibles`,
    "# PatchSettings: the ticket's array form is accepted (staged for approval, nothing changes until you approve).",
    "# Approving it REPLACES the whole setting: Arabic keeps Van Dyck, but Plain English loses the KJV (Settings shows None",
    "# for it, and its row 6 stops warning). Re-run this seed to put the KJV back.",
    patch(["arb-vandyck"]),
    "# … to approve something without losing the Plain English lane, use the map form (one Bible per lane):",
    patch(DEMO_SETTINGS.referenceBibleVersions),
    "# … an unknown Bible id gives validation_failed:",
    patch(["nope"]),
    "# … a key that is not a lane of this project gives validation_failed:",
    patch({ fr: "arb-vandyck" }),
    `# (ifMatchVersion ${settingsVersion} is the settings version right now; if a call says plan_stale, read the live one: curl -s ${auth} ${ext}/projects/${DEMO_PROJECT_ID})`,
    "# The prompt preview for row 3 shows parts.referenceVerses with the Van Dyck text, Bible resources off:",
    `curl -s ${auth} "${ext}/projects/${DEMO_PROJECT_ID}/cells/${isaiah.cellId}/prompt-preview?fileId=${fileId}"`,
    "# describe_command lists the key:",
    `curl -s ${auth} ${ext}/commands/PatchSettings | grep -o 'referenceBibleVersions.\\{0,80\\}' | head -3`,
  ].join("\n")
}

// ── Main ─────────────────────────────────────────────────────────────────────

/** Seed (or re-seed) the demo. Exported for scripts/dev-seed-reference-bible.test.ts. */
export async function main(): Promise<void> {
  const session = await signIn()
  await ensureBibles(session.jwt)
  await ensureProject(session)

  const { generation, exists } = await chooseGeneration(session.jwt)
  const fileId = demoFileId(generation)
  const rows = buildDemoRows(undefined, generation)
  const token = await syncToken(session.jwt, fileId)
  if (!exists) await importFile(token, generation, rows)
  const reset = await resetTargets(session, token, generation, rows)
  await verify(token, generation, rows)

  console.log(
    `reference Bible demo: ${exists ? "file already there" : "file imported"}` +
      `${generation > 0 ? ` (copy ${generation + 1}: an earlier copy was deleted)` : ""}, ` +
      `${reset} draft${reset === 1 ? "" : "s"} reset, settings put back.`,
  )
  console.log(`  project: ${DEMO_PROJECT_NAME}`)
  console.log(`  open:    ${WEB}/project/${DEMO_PROJECT_ID}/editor/file/${fileId}`)
  console.log(`  rows:`)
  for (const row of rows) {
    const shows = Object.entries(row.expect).map(([lane, e]) => `${lane || "Arabic"}: ${e}`).join(", ")
    console.log(`    ${String(row.n).padStart(2)}. [${shows}] ${row.note}`)
  }

  if (!process.argv.includes("--no-token")) {
    const apiToken = await mintDemoToken(session.jwt)
    const version = (await readSettings(session.jwt)).version ?? 0
    console.log("\nAgent API checks (token printed once, never saved; the previous demo token was revoked):")
    console.log(curlLines(apiToken, version, rows, fileId))
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error(`reference Bible demo seed FAILED: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
