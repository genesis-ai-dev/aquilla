// Client for the book.affirm / book.unaffirm feature (AQU-727 "mark book done").
//
// One read (the project's affirmations) and two writes (affirm / withdraw).
// Like assignments — a deliberate, low-frequency Project Lead action made from
// the project-overview page where no outbox flusher is mounted — the writes POST
// the event to the sync-worker directly and await server acceptance, giving
// immediate feedback; the caller then refreshes its affirmation list.
//
// Book affirmations are project-level, keyed on (project, book_code). The
// envelope carries a real fileId only so the sync-token can be minted and the
// event routed/authorized (verifyTokenForProject checks the projectId, not the
// file). See sync-worker/src/events/handlers/book-affirm-events.ts.

import { buildRawEvent } from "./events-emit"
import { fetchSyncToken } from "./sync-token"
import { syncWorkerHttpOrigin } from "./sync-worker-url"

/** One affirmed book (mirrors the server's BookAffirmationRowOut). */
export interface BookAffirmation {
  projectId: string
  bookCode: string
  affirmedBy: number
  affirmedByLabel: string
  eventId: string
  affirmedAt: number
  note: string | null
}

export class BookAffirmationError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "BookAffirmationError"
    this.status = status
  }
}

/**
 * Read every book affirmation for a project. `token` is any file-scoped sync
 * token for the project (project reads only verify the projectId from the JWT).
 */
export async function fetchBookAffirmations(
  projectId: string,
  token: string,
): Promise<BookAffirmation[]> {
  const res = await fetch(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/book-affirmations`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    throw new BookAffirmationError(`Request failed (HTTP ${res.status})`, res.status)
  }
  return ((await res.json()) as { affirmations: BookAffirmation[] }).affirmations
}

/** POST one already-built book.* event to the sync-worker and await acceptance. */
async function postBookEvent(
  jwt: string,
  projectId: string,
  fileId: string,
  event: ReturnType<typeof buildRawEvent>,
  projectName?: string,
): Promise<void> {
  const { token } = await fetchSyncToken(jwt, projectId, fileId, { projectName })
  let res: Response
  try {
    res = await fetch(`${syncWorkerHttpOrigin()}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: [event] }),
    })
  } catch (err) {
    throw new BookAffirmationError(err instanceof Error ? err.message : "network error")
  }
  if (!res.ok) {
    throw new BookAffirmationError(`Request failed (HTTP ${res.status})`, res.status)
  }
  const body = (await res.json().catch(() => null)) as {
    accepted?: Array<{ id: string }>
    rejected?: Array<{ id: string; status: number; reason: string }>
  } | null
  const rejected = body?.rejected ?? []
  if (rejected.length > 0) {
    throw new BookAffirmationError(rejected[0].reason || "event rejected", rejected[0].status)
  }
  if (!(body?.accepted ?? []).some((a) => a.id === event.id)) {
    throw new BookAffirmationError("event was not accepted by the server")
  }
}

export interface AffirmBookArgs {
  jwt: string
  projectId: string
  /** A representative file of the book — routes the sync token / event auth.
   *  The affirmed unit is the bookCode (project-level), not this file. */
  fileId: string
  bookCode: string
  /** The lead's username (stamped as author; server re-verifies against the JWT). */
  author: string
  note?: string | null
  projectName?: string
}

/**
 * Affirm a book "done". Emits one `book.affirm` event and awaits acceptance.
 * Throws BookAffirmationError on transport failure or server rejection (e.g.
 * role below project_lead → 403).
 */
export async function affirmBook(args: AffirmBookArgs): Promise<void> {
  const event = buildRawEvent({
    kind: "book.affirm",
    projectId: args.projectId,
    fileId: args.fileId,
    parentId: null,
    author: args.author,
    payload: {
      bookCode: args.bookCode,
      ...(args.note !== undefined ? { note: args.note } : {}),
    },
  })
  await postBookEvent(args.jwt, args.projectId, args.fileId, event, args.projectName)
}

export interface UnaffirmBookArgs {
  jwt: string
  projectId: string
  fileId: string
  bookCode: string
  author: string
  projectName?: string
}

/** Withdraw a prior book affirmation. Emits one `book.unaffirm` event. */
export async function unaffirmBook(args: UnaffirmBookArgs): Promise<void> {
  const event = buildRawEvent({
    kind: "book.unaffirm",
    projectId: args.projectId,
    fileId: args.fileId,
    parentId: null,
    author: args.author,
    payload: { bookCode: args.bookCode },
  })
  await postBookEvent(args.jwt, args.projectId, args.fileId, event, args.projectName)
}
