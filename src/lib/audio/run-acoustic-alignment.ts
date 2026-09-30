import { ALIGNMENT_JOB_TIMEOUT_MS, isAcousticAlignmentResult, type AcousticAlignmentResult } from "../../../shared/script-alignment"
import { syncWorkerHttpOrigin } from "../sync/sync-worker-url"
import { parseFrontierAudioUrl } from "./upload"

export interface AcousticAlignmentOptions {
  projectId: string
  fileId: string
  clipUrl: string
  script: string
  language: string
  getToken(fileId: string): Promise<string | null>
  signal?: AbortSignal
  request?: typeof fetch
  wait?(signal?: AbortSignal): Promise<void>
}

function waitForPoll(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", cancel); resolve() }
    const timer = setTimeout(finish, 2500)
    const cancel = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
      reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"))
    }
    signal?.addEventListener("abort", cancel, { once: true })
  })
}

/** The browser talks only to its file-scoped worker; Modal credentials stay server-side. */
export async function runAcousticAlignment(
  options: AcousticAlignmentOptions,
): Promise<AcousticAlignmentResult> {
  options.signal?.throwIfAborted()
  const clip = parseFrontierAudioUrl(options.clipUrl)
  if (!clip || /[/\\]/.test(`${clip.audioId}.${clip.ext}`)
      || options.clipUrl.includes(String.fromCharCode(0))) {
    throw new Error("Choose an uploaded source audio clip.")
  }
  const request = options.request ?? fetch
  const base = `${syncWorkerHttpOrigin()}/api/v1/alignment`
  const authorizedRequest = async (url: string, init: RequestInit = {}) => {
    options.signal?.throwIfAborted()
    const controller = new AbortController()
    const cancel = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", cancel, { once: true })
    const timer = setTimeout(() => controller.abort(
      new Error("Acoustic alignment request timed out."),
    ), 60_000)
    let rejectOnAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true })
    })
    try {
      return await Promise.race([aborted, (async () => {
        const token = await options.getToken(options.fileId)
        controller.signal.throwIfAborted()
        if (!token) throw new Error("Sign in to align source audio.")
        const response = await request(url, { ...init,
          headers: { ...init.headers, Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        if (!response.ok) throw new Error(`Acoustic alignment request failed (${response.status}).`)
        return await response.json() as Record<string, unknown>
      })()])
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", cancel)
      controller.signal.removeEventListener("abort", rejectOnAbort)
    }
  }
  const started = await authorizedRequest(`${base}/start`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: options.projectId, fileId: options.fileId,
      audioObject: `${clip.audioId}.${clip.ext}`, script: options.script,
      language: options.language }),
  })
  if (typeof started.jobId !== "string" || !started.jobId) {
    throw new Error("Acoustic alignment returned no job identifier.")
  }
  const deadline = Date.now() + ALIGNMENT_JOB_TIMEOUT_MS
  for (;;) {
    options.signal?.throwIfAborted()
    if (Date.now() > deadline) throw new Error("Acoustic alignment timed out.")
    const status = await authorizedRequest(`${base}/status?jobId=${encodeURIComponent(started.jobId)}`)
    if (status.status === "done") {
      if (!isAcousticAlignmentResult(status.result, options.script)) {
        throw new Error("Invalid acoustic alignment result.")
      }
      return status.result
    }
    if (status.status === "failed") throw new Error(
      typeof status.error === "string" ? status.error : "Acoustic alignment failed.",
    )
    if (!["queued", "running"].includes(String(status.status))) {
      throw new Error("Invalid acoustic alignment job state.")
    }
    await (options.wait ?? waitForPoll)(options.signal)
  }
}
