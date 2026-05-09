/**
 * Dev-only smoke surface for the new local-store + outbox stack.
 * Renders cells from a fixture snapshot ingested into an OPFS-backed
 * SQLite-WASM database. Edits route through the outbox.
 *
 * Also exercises the §13.5 drift-recovery path: when LocalStore.open
 * throws MigrationDriftError, this page renders a "Wipe and reload"
 * affordance instead of the editor, surfacing pending outbox state so
 * the user can copy anything they care about before the wipe.
 *
 * See docs/DATA_PERSISTENCE_PLAN.md and the e2e spec at
 * `e2e/specs/local-store/demo.smoke.spec.ts`.
 */

import { useEffect, useRef, useState } from "react"
import {
  enqueueOutboxRecord,
  getCellsByScope,
  getProjectMeta,
  ingestSnapshot,
  listPending,
  LocalStore,
  MIGRATIONS,
  MigrationDriftError,
  upsertCell,
  wipeOpfsDb,
  type CellRow,
} from "@/lib/local-store"

const PROJECT_ID = "demo"
const SCOPE_ID = "scope-1"
const DB_NAME = "codex-demo"

const FIXTURE_LINES: string[] = [
  JSON.stringify({
    type: "snapshot_meta",
    snapshot_seq: 1,
    project_id: PROJECT_ID,
    generated_at: 0,
  }),
  JSON.stringify({
    type: "project_meta",
    project_id: PROJECT_ID,
    org_id: "demo-org",
    name: "Demo Project",
    library_doc_id: "demo-lib",
    bound_version_id: "demo-ver",
    source_lang: "eng",
    target_lang: "spa",
  }),
  ...["In the beginning God created the heavens and the earth.",
    "And the earth was without form, and void; and darkness was upon the face of the deep.",
    "And the Spirit of God moved upon the face of the waters."].map(
    (text, i) =>
      JSON.stringify({
        type: "cell",
        id: `${PROJECT_ID}:cell-${i + 1}`,
        project_id: PROJECT_ID,
        scope_id: SCOPE_ID,
        address: `cell-${i + 1}`,
        ord: i,
        kind: "text",
        parent_cell_id: null,
        source_text: text,
        source_text_hash: `h-${i + 1}`,
        source_version_id: "demo-ver",
        translation_text: "",
        tag_dictionary: "{}",
        status: "empty",
        approved_at_version: null,
        locked_by_user_id: null,
        version: 0,
        last_edited_by: null,
        last_edited_at: null,
        seq: 1,
        created_at: 0,
        updated_at: 0,
        org_id: "demo-org",
        source_lang: "eng",
        target_lang: "spa",
        format_meta: "{}",
      }),
  ),
]

async function* asLines(arr: string[]): AsyncIterable<string> {
  for (const line of arr) yield line
}

/**
 * Dev-only: corrupt _migrations.content_hash for the demo db, then redirect
 * to the bare /dev/local-store route. The next mount sees drift on open.
 * Triggered via `?simulate-drift=1`. Intended for the Playwright suite —
 * production users should never see this code path.
 */
async function simulateDriftAndRedirect(): Promise<void> {
  const tmp = await LocalStore.open({ name: DB_NAME })
  try {
    await tmp.migrate(MIGRATIONS)
    await tmp.run(
      "UPDATE _migrations SET content_hash = 'tampered-for-test' WHERE version = 1",
    )
  } finally {
    await tmp.close()
  }
  window.location.replace("/dev/local-store")
}

export default function LocalStoreDemo() {
  const [store, setStore] = useState<LocalStore | null>(null)
  const [cells, setCells] = useState<CellRow[]>([])
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [driftError, setDriftError] = useState<MigrationDriftError | null>(null)
  const [wiping, setWiping] = useState(false)
  const storeRef = useRef<LocalStore | null>(null)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams(window.location.search)

    if (params.has("simulate-drift")) {
      void simulateDriftAndRedirect()
      return
    }

    ;(async () => {
      try {
        const s = await LocalStore.open({ name: DB_NAME })
        await s.migrate(MIGRATIONS)
        const existing = await getProjectMeta(s, PROJECT_ID)
        if (!existing) {
          await ingestSnapshot(s, asLines(FIXTURE_LINES))
        }
        if (cancelled) {
          await s.close()
          return
        }
        storeRef.current = s
        const rows = await getCellsByScope(s, PROJECT_ID, SCOPE_ID)
        const outbox = await listPending(s)
        setStore(s)
        setCells(rows)
        setPending(outbox.length)
      } catch (e) {
        if (cancelled) return
        if (e instanceof MigrationDriftError) {
          setDriftError(e)
        } else {
          setError((e as Error).message)
        }
      }
    })()
    return () => {
      cancelled = true
      if (storeRef.current) {
        void storeRef.current.close()
      }
    }
  }, [])

  async function handleEdit(cellId: string, value: string): Promise<void> {
    const s = storeRef.current
    if (!s) return
    const cell = cells.find((c) => c.id === cellId)
    if (!cell) return
    const newVersion = cell.version + 1
    const updated: CellRow = {
      ...cell,
      translation_text: value,
      version: newVersion,
      updated_at: Date.now(),
    }
    await upsertCell(s, updated)
    await enqueueOutboxRecord(s, {
      local_id: `${cellId}@${newVersion}-${Date.now()}`,
      project_id: cell.project_id,
      endpoint: `/projects/${cell.project_id}/cells/${cellId}`,
      payload: JSON.stringify({
        translation_text: value,
        expected_version: cell.version,
      }),
      expected_version: cell.version,
      created_at: Date.now(),
    })
    setCells((prev) => prev.map((c) => (c.id === cellId ? updated : c)))
    const outbox = await listPending(s)
    setPending(outbox.length)
  }

  async function handleWipeAndReload(): Promise<void> {
    setWiping(true)
    if (storeRef.current) {
      await storeRef.current.close().catch(() => {})
      storeRef.current = null
    }
    await wipeOpfsDb(DB_NAME)
    window.location.reload()
  }

  if (driftError) {
    return (
      <div
        data-testid="local-store-demo-drift"
        className="max-w-2xl mx-auto p-6"
      >
        <h1 className="text-xl font-bold mb-2">Local cache out of date</h1>
        <p className="text-sm text-gray-700 mb-3">
          Your browser's local copy of this project was created by an older
          version of the app and is no longer compatible. Reload to clear it
          and re-fetch from the server.
        </p>
        <p className="text-xs text-gray-500 mb-4 font-mono">
          migration {driftError.version}: stored {driftError.stored.slice(0, 12)}…,
          now {driftError.current.slice(0, 12)}…
        </p>
        <button
          type="button"
          data-testid="drift-wipe-button"
          onClick={() => void handleWipeAndReload()}
          disabled={wiping}
          className="rounded bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm px-3 py-2"
        >
          {wiping ? "Wiping…" : "Wipe and reload"}
        </button>
      </div>
    )
  }

  if (error) {
    return (
      <div
        data-testid="local-store-demo-error"
        className="max-w-2xl mx-auto p-6 text-red-600"
      >
        <h1 className="text-xl font-bold mb-2">Local Store Demo</h1>
        <pre className="text-sm whitespace-pre-wrap">{error}</pre>
        <button
          type="button"
          data-testid="error-wipe-button"
          onClick={() => void handleWipeAndReload()}
          disabled={wiping}
          className="mt-3 rounded bg-gray-700 hover:bg-gray-800 disabled:opacity-50 text-white text-sm px-3 py-2"
        >
          {wiping ? "Wiping…" : "Reset local cache"}
        </button>
      </div>
    )
  }

  if (!store) {
    return (
      <div
        data-testid="local-store-demo-loading"
        className="max-w-2xl mx-auto p-6 text-gray-600"
      >
        <h1 className="text-xl font-bold mb-2">Local Store Demo</h1>
        <p>Opening local SQLite database…</p>
      </div>
    )
  }

  return (
    <div data-testid="local-store-demo" className="max-w-2xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-1">Local Store Demo</h1>
      <p className="text-sm text-gray-600 mb-4">
        OPFS-backed SQLite-WASM, snapshot ingested, cells editable via outbox.
      </p>
      <div
        data-testid="pending-count"
        className="mb-4 inline-block rounded bg-amber-50 border border-amber-200 px-2 py-1 text-xs text-amber-800"
      >
        Pending mutations: <span data-testid="pending-count-value">{pending}</span>
      </div>
      <ul className="divide-y border rounded">
        {cells.map((cell) => (
          <li
            key={cell.id}
            data-testid={`cell-${cell.id}`}
            className="px-3 py-3"
          >
            <div className="text-xs text-gray-500 mb-1">{cell.address}</div>
            <div className="text-sm mb-2">{cell.source_text}</div>
            <input
              type="text"
              className="w-full border rounded px-2 py-1 text-sm"
              placeholder="Translation…"
              value={cell.translation_text}
              data-testid={`translation-${cell.id}`}
              onChange={(e) => {
                void handleEdit(cell.id, e.target.value)
              }}
            />
          </li>
        ))}
      </ul>
      <div className="mt-6 pt-4 border-t border-gray-200 flex items-center gap-3">
        <button
          type="button"
          data-testid="reset-cache-button"
          onClick={() => void handleWipeAndReload()}
          disabled={wiping}
          className="rounded bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-gray-800 text-xs px-2 py-1 border border-gray-300"
        >
          {wiping ? "Wiping…" : "Reset local cache"}
        </button>
        <span className="text-xs text-gray-500">
          Wipes OPFS for this project and reloads.
        </span>
      </div>
    </div>
  )
}
