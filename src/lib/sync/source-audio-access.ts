import { syncWorkerHttpOrigin } from "./sync-worker-url"

/** A hung request on a weak network gives up and is retried. */
const TIMEOUT_MS = 15_000

/**
 * AQU-2682: the server's answer to "does the signed-in person's access cover
 * every language of this project?" — what storing the file's source audio
 * ("Upload a recording to make lines", attaching media by url) needs. The
 * server computes it with the rule its events route enforces
 * (sync-worker/src/events/source-audio-access.ts), so the app does not guess.
 *
 * Throws on anything but a clear answer (no session, network, server error,
 * an unexpected body): the caller treats that as "not known", never as yes.
 */
export async function fetchSourceAudioAccess(args: {
  projectId: string
  fileId: string
  getToken: (fileId: string) => Promise<string | null>
}): Promise<boolean> {
  const token = await args.getToken(args.fileId)
  if (!token) throw new Error("source audio access awaits a session")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(
      `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}/source-audio-access`,
      { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: "no-store" },
    )
    if (!res.ok) throw new Error(`source audio access read failed (${res.status})`)
    const body = (await res.json()) as { coversEveryLanguage?: unknown }
    if (typeof body?.coversEveryLanguage !== "boolean") throw new Error("source audio access: unexpected answer")
    return body.coversEveryLanguage
  } finally {
    clearTimeout(timer)
  }
}
