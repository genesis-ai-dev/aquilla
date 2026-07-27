import { inspectIdml } from "./archive.js"
import { IdmlError } from "./errors.js"
import { exportIdml, parseIdml, validateExport } from "./engine.js"
import type {
  IdmlDiagnostic,
  IdmlLimits,
  IdmlProgress,
  IdmlSourceManifest,
  IdmlTranslation,
} from "./types.js"

export const idmlWorkerApi = {
  inspectIdml,
  parseIdml,
  exportIdml,
  validateExport,
}

export type IdmlWorkerApi = typeof idmlWorkerApi

export type IdmlWorkerRequest =
  | {
      readonly type: "request"
      readonly id: string
      readonly method: "inspect"
      readonly bytes: ArrayBuffer
      readonly limits?: Partial<IdmlLimits>
    }
  | {
      readonly type: "request"
      readonly id: string
      readonly method: "parse"
      readonly bytes: ArrayBuffer
      readonly profile?: "generic" | "biblica"
      readonly limits?: Partial<IdmlLimits>
    }
  | {
      readonly type: "request"
      readonly id: string
      readonly method: "export"
      readonly bytes: ArrayBuffer
      readonly translations: readonly IdmlTranslation[]
      readonly limits?: Partial<IdmlLimits>
    }
  | {
      readonly type: "request"
      readonly id: string
      readonly method: "validate"
      readonly bytes: ArrayBuffer
      readonly manifest: IdmlSourceManifest
      readonly limits?: Partial<IdmlLimits>
    }
  | {
      readonly type: "cancel"
      readonly id: string
    }

export type IdmlWorkerResponse =
  | {
      readonly type: "progress"
      readonly id: string
      readonly progress: IdmlProgress
    }
  | {
      readonly type: "success"
      readonly id: string
      readonly result: unknown
    }
  | {
      readonly type: "error"
      readonly id: string
      readonly error: IdmlWorkerError
    }

export interface IdmlWorkerError {
  readonly name: string
  readonly message: string
  readonly code?: string
  readonly diagnostics?: readonly IdmlDiagnostic[]
}

export interface IdmlWorkerEndpoint {
  postMessage(message: IdmlWorkerResponse, transfer?: Transferable[]): void
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<IdmlWorkerRequest>) => void,
  ): void
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<IdmlWorkerRequest>) => void,
  ): void
}

/**
 * Installs the IDML request protocol on a browser WorkerGlobalScope-compatible
 * endpoint. The returned disposer aborts active work and detaches the listener.
 */
export function attachIdmlWorker(endpoint: IdmlWorkerEndpoint): () => void {
  const active = new Map<string, AbortController>()

  const onMessage = (event: MessageEvent<IdmlWorkerRequest>): void => {
    const request = event.data
    if (!isWorkerRequest(request)) {
      postError(endpoint, "", new TypeError("Invalid IDML worker request"))
      return
    }
    if (request.type === "cancel") {
      active.get(request.id)?.abort(new DOMException("IDML operation cancelled", "AbortError"))
      return
    }
    if (active.has(request.id)) {
      postError(endpoint, request.id, new TypeError(`Duplicate IDML worker request id ${request.id}`))
      return
    }

    const controller = new AbortController()
    active.set(request.id, controller)
    void executeWorkerRequest(endpoint, request, controller.signal).finally(() => {
      active.delete(request.id)
    })
  }

  endpoint.addEventListener("message", onMessage)
  return () => {
    endpoint.removeEventListener("message", onMessage)
    for (const controller of active.values()) {
      controller.abort(new DOMException("IDML worker detached", "AbortError"))
    }
    active.clear()
  }
}

async function executeWorkerRequest(
  endpoint: IdmlWorkerEndpoint,
  request: Exclude<IdmlWorkerRequest, { readonly type: "cancel" }>,
  signal: AbortSignal,
): Promise<void> {
  const onProgress = (progress: IdmlProgress): void => {
    endpoint.postMessage({ type: "progress", id: request.id, progress })
  }

  try {
    let result: unknown
    switch (request.method) {
      case "inspect": {
        throwIfWorkerAborted(signal)
        onProgress({ phase: "inspect", completed: 0, total: 1 })
        result = await inspectIdml(request.bytes, request.limits)
        throwIfWorkerAborted(signal)
        onProgress({ phase: "inspect", completed: 1, total: 1 })
        break
      }
      case "parse":
        result = await parseIdml(request.bytes, request.profile ?? "generic", {
          ...(request.limits ? { limits: request.limits } : {}),
          signal,
          onProgress,
        })
        break
      case "export":
        result = await exportIdml(request.bytes, request.translations, {
          strict: true,
          ...(request.limits ? { limits: request.limits } : {}),
          signal,
          onProgress,
        })
        break
      case "validate":
        result = await validateExport(request.bytes, request.manifest, {
          ...(request.limits ? { limits: request.limits } : {}),
          signal,
          onProgress,
        })
        break
    }

    const transfer = exportResultTransfer(result)
    endpoint.postMessage(
      { type: "success", id: request.id, result },
      transfer.length > 0 ? transfer : undefined,
    )
  } catch (error) {
    postError(endpoint, request.id, error)
  }
}

function postError(endpoint: IdmlWorkerEndpoint, id: string, error: unknown): void {
  endpoint.postMessage({
    type: "error",
    id,
    error: serializeWorkerError(error),
  })
}

function serializeWorkerError(error: unknown): IdmlWorkerError {
  if (error instanceof IdmlError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      diagnostics: error.diagnostics,
    }
  }
  if (error instanceof Error || error instanceof DOMException) {
    return {
      name: error.name,
      message: error.message,
    }
  }
  return {
    name: "Error",
    message: String(error),
  }
}

function exportResultTransfer(result: unknown): Transferable[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !("bytes" in result) ||
    !((result as { readonly bytes?: unknown }).bytes instanceof Uint8Array)
  ) {
    return []
  }
  const buffer = (result as { readonly bytes: Uint8Array }).bytes.buffer
  return buffer instanceof ArrayBuffer ? [buffer] : []
}

function throwIfWorkerAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("IDML operation cancelled", "AbortError")
  }
}

function isWorkerRequest(value: unknown): value is IdmlWorkerRequest {
  if (typeof value !== "object" || value === null || !("type" in value) || !("id" in value)) {
    return false
  }
  const candidate = value as { readonly type?: unknown; readonly id?: unknown; readonly method?: unknown }
  if (typeof candidate.id !== "string") return false
  if (candidate.type === "cancel") return true
  return (
    candidate.type === "request" &&
    (candidate.method === "inspect" ||
      candidate.method === "parse" ||
      candidate.method === "export" ||
      candidate.method === "validate")
  )
}

const workerGlobal = globalThis as unknown as Partial<IdmlWorkerEndpoint> & {
  readonly document?: unknown
}
if (
  workerGlobal.document === undefined &&
  typeof workerGlobal.postMessage === "function" &&
  typeof workerGlobal.addEventListener === "function" &&
  typeof workerGlobal.removeEventListener === "function"
) {
  attachIdmlWorker(workerGlobal as IdmlWorkerEndpoint)
}
