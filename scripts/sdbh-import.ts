// Bulk-load SDBH lexicon localizations into Aquilla projects — one project per
// language edition, e.g. under a dedicated org.
//
//   npx tsx scripts/sdbh-import.ts --dir /path/to/SDBH/Local --lang es
//   npx tsx scripts/sdbh-import.ts --dir /path/to/SDBH/Local --all
//
// Options:
//   --dir <path>       MARBLE Local directory holding SDBH-<lang>.JSON editions (required)
//   --lang <code>      One localization (repeatable). --all imports every SDBH-*.JSON except the master.
//   --master <code>    Master edition supplying structure + source text (default: en)
//   --org-id <n>       Org to create the projects in (default: caller's personal org)
//   --auth <origin>    auth-worker origin   (default: http://127.0.0.1:8788)
//   --sync <origin>    sync-worker origin   (default: http://127.0.0.1:8789)
//   --jwt <token>      Session JWT. Omit locally → POST /__dev__/login.
//   --prefix <name>    Project-name prefix (default: "SDBH")
//
// Mirrors the in-app importer exactly (src/lib/import-sdbh.ts): same parser,
// same cell ids, same /import + target.cell.commit shapes — so a scripted load
// and a dialog import are interchangeable, and export round-trips either way.
// The upload plumbing is re-implemented here because the browser sync modules
// resolve their origin from import.meta.env (Vite-only).
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { v7 as uuidv7 } from "uuid"
import {
  parseSdbhLexicon,
  extractSdbhLocalized,
  type SdbhEntry,
} from "../src/lib/parsers/sdbh"
import type { TranslatableString } from "../src/lib/parsers/types"

const IMPORT_CHUNK = 1500
const TARGET_CHUNK = 200

// --- arg parsing -------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args = {
    dir: "",
    langs: [] as string[],
    all: false,
    master: "en",
    orgId: undefined as number | undefined,
    auth: process.env.AUTH_BASE ?? "http://127.0.0.1:8788",
    sync: process.env.SYNC_BASE ?? "http://127.0.0.1:8789",
    jwt: process.env.AQUILLA_JWT ?? "",
    prefix: "SDBH",
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dir") args.dir = argv[++i]
    else if (a === "--lang") args.langs.push(argv[++i])
    else if (a === "--all") args.all = true
    else if (a === "--master") args.master = argv[++i]
    else if (a === "--org-id") args.orgId = Number(argv[++i])
    else if (a === "--auth") args.auth = argv[++i]
    else if (a === "--sync") args.sync = argv[++i]
    else if (a === "--jwt") args.jwt = argv[++i]
    else if (a === "--prefix") args.prefix = argv[++i]
    else throw new Error(`unknown arg: ${a}`)
  }
  if (!args.dir) throw new Error("--dir is required")
  if (!args.all && args.langs.length === 0) throw new Error("pass --lang <code> (repeatable) or --all")
  return args
}

// --- auth helpers ------------------------------------------------------------

async function devLogin(auth: string): Promise<string> {
  const res = await fetch(`${auth}/__dev__/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  if (!res.ok) throw new Error(`dev login HTTP ${res.status} — pass --jwt for non-dev targets`)
  return ((await res.json()) as { access_token: string }).access_token
}

async function createProject(
  auth: string,
  jwt: string,
  args: { id: string; name: string; orgId?: number },
): Promise<{ id: string; name: string; orgId: number }> {
  const res = await fetch(`${auth}/api/v2/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(args),
  })
  if (!res.ok) throw new Error(`create project HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()) as { id: string; name: string; orgId: number }
}

async function mintToken(auth: string, jwt: string, projectId: string, fileId: string, projectName: string): Promise<string> {
  const res = await fetch(`${auth}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ projectId, fileId, projectName }),
  })
  if (!res.ok) throw new Error(`sync-token HTTP ${res.status}: ${await res.text()}`)
  return ((await res.json()) as { token: string }).token
}

// --- upload (mirrors src/lib/sync/bulk-import.ts payloads) --------------------

interface BulkCell {
  id: string
  cellId: string
  anchorCellId: string | null
  value: string
  type?: string
  canonicalRef?: string
  sequenceIndex: number
  paragraphStart?: boolean
  metadata?: Record<string, unknown>
}

function buildCells(strings: TranslatableString[]): BulkCell[] {
  let prev: string | null = null
  return strings.map((str, seq) => {
    const cell: BulkCell = {
      id: uuidv7(),
      cellId: str.id,
      anchorCellId: prev,
      value: str.original,
      type: str.type,
      ...(str.group ? { canonicalRef: str.group } : {}),
      sequenceIndex: seq,
      ...(str.paragraphStart ? { paragraphStart: true } : {}),
      ...(str.metadata ? { metadata: str.metadata } : {}),
    }
    prev = str.id
    return cell
  })
}

async function postJson(url: string, token: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const editions = readdirSync(args.dir)
    .filter((n) => /^SDBH-.+\.JSON$/i.test(n))
    .map((n) => n.replace(/^SDBH-/i, "").replace(/\.JSON$/i, ""))
  const langs = args.all ? editions.filter((l) => l !== args.master) : args.langs
  for (const l of [...langs, args.master]) {
    if (!editions.includes(l)) throw new Error(`edition SDBH-${l}.JSON not found in ${args.dir}`)
  }

  const jwt = args.jwt || (await devLogin(args.auth))

  console.log(`master: ${args.master}; importing ${langs.length} localization(s): ${langs.join(", ")}`)
  const masterEntries = JSON.parse(
    readFileSync(join(args.dir, `SDBH-${args.master}.JSON`), "utf-8"),
  ) as SdbhEntry[]
  const parsed = parseSdbhLexicon(masterEntries)
  const allFiles = [...parsed.files, parsed.domainFile]
  console.log(`parsed master: ${parsed.entryCount} entries, ${parsed.senseCount} senses, ${allFiles.length} files`)

  for (const lang of langs) {
    const projectId = `sdbh-${lang}-${uuidv7().slice(-8)}`
    const projectName = `${args.prefix} ${lang}`
    const project = await createProject(args.auth, jwt, {
      id: projectId,
      name: projectName,
      ...(args.orgId !== undefined ? { orgId: args.orgId } : {}),
    })
    console.log(`\n[${lang}] project ${project.id} (org ${project.orgId})`)

    const localized = extractSdbhLocalized(
      JSON.parse(readFileSync(join(args.dir, `SDBH-${lang}.JSON`), "utf-8")) as SdbhEntry[],
    )
    console.log(`[${lang}] ${localized.byCellId.size.toLocaleString()} localized strings (LanguageCode=${localized.languageCode})`)

    let sourceTotal = 0
    let targetTotal = 0
    for (const parsedFile of allFiles) {
      const fileId = uuidv7()
      const token = await mintToken(args.auth, jwt, projectId, fileId, projectName)
      const cells = buildCells(parsedFile.strings)

      for (let offset = 0; offset === 0 || offset < cells.length; offset += IMPORT_CHUNK) {
        const chunk = cells.slice(offset, offset + IMPORT_CHUNK)
        const payload: Record<string, unknown> = { projectId, fileId, cells: chunk, clientTs: Date.now() }
        if (offset === 0) {
          payload.file = {
            id: uuidv7(),
            name: parsedFile.name,
            fileType: "sdbh",
            role: "source",
            kind: "sdbh",
            importFormat: "sdbh",
            parserVersion: "sdbh-import-v1",
            sourceLanguage: "hbo",
            targetLanguage: localized.languageCode ?? lang,
            orderedBy: "sequence",
          }
        }
        await postJson(`${args.sync}/import`, token, payload)
      }
      sourceTotal += cells.length

      const commits = cells
        .map((c) => ({ cell: c, value: localized.byCellId.get(c.cellId) }))
        .filter((x): x is { cell: BulkCell; value: string } => Boolean(x.value))
      for (let offset = 0; offset < commits.length; offset += TARGET_CHUNK) {
        const events = commits.slice(offset, offset + TARGET_CHUNK).map(({ cell, value }) => ({
          id: uuidv7(),
          schemaVersion: 1,
          kind: "target.cell.commit",
          projectId,
          fileId,
          cellId: cell.cellId,
          parentId: cell.id,
          author: "sdbh-import",
          payload: { value, sourceEventId: cell.id },
          clientTs: Date.now(),
        }))
        await postJson(`${args.sync}/events`, token, { events })
      }
      targetTotal += commits.length
      process.stdout.write(`  ${parsedFile.name}: ${cells.length} source / ${commits.length} target\n`)
    }
    console.log(`[${lang}] DONE — ${sourceTotal.toLocaleString()} source cells, ${targetTotal.toLocaleString()} target commits`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
