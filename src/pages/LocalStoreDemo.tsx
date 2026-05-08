/**
 * Dev-only smoke surface for the new local-store + outbox stack.
 * Renders cells from a fixture snapshot ingested into an in-memory
 * SQLite-WASM database. Edits route through the outbox.
 *
 * See docs/DATA_PERSISTENCE_PLAN.md and the e2e spec at
 * `e2e/specs/local-store/demo.smoke.spec.ts`.
 */

import { useEffect, useRef, useState } from "react"
import {
  enqueueOutboxRecord,
  getCellsByScope,
  ingestSnapshot,
  listPending,
  LocalStore,
  MIGRATIONS,
  upsertCell,
  type CellRow,
} from "@/lib/local-store"

const PROJECT_ID = "demo"
const SCOPE_ID = "scope-1"

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

export default function LocalStoreDemo() {
  const [store, setStore] = useState<LocalStore | null>(null)
  const [cells, setCells] = useState<CellRow[]>([])
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const storeRef = useRef<LocalStore | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await LocalStore.open({ name: ":memory:" })
        await s.migrate(MIGRATIONS)
        await ingestSnapshot(s, asLines(FIXTURE_LINES))
        if (cancelled) {
          await s.close()
          return
        }
        storeRef.current = s
        const rows = await getCellsByScope(s, PROJECT_ID, SCOPE_ID)
        setStore(s)
        setCells(rows)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
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

  if (error) {
    return (
      <div
        data-testid="local-store-demo-error"
        className="max-w-2xl mx-auto p-6 text-red-600"
      >
        <h1 className="text-xl font-bold mb-2">Local Store Demo</h1>
        <pre className="text-sm whitespace-pre-wrap">{error}</pre>
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
        In-memory SQLite-WASM, snapshot ingested, cells editable via outbox.
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
    </div>
  )
}
