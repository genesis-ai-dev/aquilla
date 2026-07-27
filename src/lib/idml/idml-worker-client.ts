import type {
  IdmlDiagnostic,
  IdmlExportResult,
  IdmlLimits,
  IdmlPackageInspection,
  IdmlParseResult,
  IdmlProgress,
  IdmlSourceManifest,
  IdmlTranslation,
} from "@aquilla/idml-roundtrip"
import type {
  IdmlWorkerError,
  IdmlWorkerRequest,
  IdmlWorkerResponse,
} from "@aquilla/idml-roundtrip/worker"

export interface IdmlWorkerCallOptions {
  limits?: Partial<IdmlLimits>
  signal?: AbortSignal
  onProgress?: (progress: IdmlProgress) => void
}

export type IdmlWorkerFactory = () => Worker | Promise<Worker>

export interface CreateIdmlWorkerClientOptions {
  /** Injection seam for deterministic protocol tests. Production always uses
   * the bundled worker entry and never runs large IDML operations inline. */
  createWorker?: IdmlWorkerFactory
}

export interface IdmlWorkerClient {
  inspect(
    bytes: ArrayBuffer,
    options?: IdmlWorkerCallOptions,
  ): Promise<IdmlPackageInspection>
  parse(
    bytes: ArrayBuffer,
    profile?: "generic" | "biblica",
    options?: IdmlWorkerCallOptions,
  ): Promise<IdmlParseResult>
  export(
    bytes: ArrayBuffer,
    translations: readonly IdmlTranslation[],
    options?: IdmlWorkerCallOptions,
  ): Promise<IdmlExportResult>
  validate(
    bytes: ArrayBuffer,
    manifest: IdmlSourceManifest,
    options?: IdmlWorkerCallOptions,
  ): Promise<readonly IdmlDiagnostic[]>
  dispose(): void
}

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (error: unknown) => void
  onProgress?: (progress: IdmlProgress) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type IdmlWorkerOperation<
  Request extends Exclude<IdmlWorkerRequest, { readonly type: "cancel" }> =
    Exclude<IdmlWorkerRequest, { readonly type: "cancel" }>,
> = Request extends unknown ? Omit<Request, "type" | "id" | "bytes"> : never

export class IdmlWorkerClientError extends Error {
  readonly code?: string
  readonly diagnostics?: readonly IdmlDiagnostic[]

  constructor(remote: IdmlWorkerError) {
    super(remote.message)
    this.name = remote.name || "IdmlWorkerClientError"
    this.code = remote.code
    this.diagnostics = remote.diagnostics
  }
}

let requestSequence = 0

const defaultCreateWorker: IdmlWorkerFactory = async () => {
  if (typeof Worker === "undefined") {
    throw new Error("IDML operations require a Web Worker in this runtime")
  }
  const module = await import("./idml.worker?worker")
  const WorkerConstructor = module.default as new () => Worker
  return new WorkerConstructor()
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("IDML operation cancelled", "AbortError")
}

/**
 * Create a reusable, concurrent IDML worker client.
 *
 * Every operation transfers ownership of `bytes` to the worker without making
 * a hidden copy. The supplied ArrayBuffer is detached after dispatch. Callers
 * that need a recovery/original copy must explicitly pass `bytes.slice(0)` or
 * re-read their Blob/File after the operation.
 */
export function createIdmlWorkerClient(
  options: CreateIdmlWorkerClientOptions = {},
): IdmlWorkerClient {
  const createWorker = options.createWorker ?? defaultCreateWorker
  const pending = new Map<string, PendingCall>()
  let disposed = false
  let worker: Worker | undefined
  let workerPromise: Promise<Worker> | undefined

  const clearPending = (id: string): PendingCall | undefined => {
    const call = pending.get(id)
    if (!call) return undefined
    pending.delete(id)
    if (call.signal && call.onAbort) {
      call.signal.removeEventListener("abort", call.onAbort)
    }
    return call
  }

  const rejectAll = (error: Error): void => {
    for (const id of [...pending.keys()]) {
      clearPending(id)?.reject(error)
    }
  }

  const onMessage = (event: MessageEvent<IdmlWorkerResponse>): void => {
    const response = event.data
    if (!response || typeof response.id !== "string") return
    const call = pending.get(response.id)
    if (!call) return
    if (response.type === "progress") {
      call.onProgress?.(response.progress)
      return
    }
    clearPending(response.id)
    if (response.type === "success") {
      call.resolve(response.result)
    } else {
      call.reject(new IdmlWorkerClientError(response.error))
    }
  }

  const onError = (event: ErrorEvent): void => {
    rejectAll(new Error(event.message || "IDML worker crashed"))
  }

  const getWorker = async (): Promise<Worker> => {
    if (disposed) throw new Error("IDML worker client has been disposed")
    if (!workerPromise) {
      workerPromise = Promise.resolve(createWorker()).then((created) => {
        if (disposed) {
          created.terminate()
          throw new Error("IDML worker client has been disposed")
        }
        worker = created
        created.addEventListener("message", onMessage as EventListener)
        created.addEventListener("error", onError as EventListener)
        return created
      })
    }
    return workerPromise
  }

  const call = async <Result>(
    request: IdmlWorkerOperation,
    bytes: ArrayBuffer,
    callOptions?: IdmlWorkerCallOptions,
  ): Promise<Result> => {
    if (callOptions?.signal?.aborted) throw abortError(callOptions.signal)
    const endpoint = await getWorker()
    if (callOptions?.signal?.aborted) throw abortError(callOptions.signal)
    const id = `idml-${Date.now()}-${++requestSequence}`
    const message = { type: "request", id, ...request, bytes } as Exclude<
      IdmlWorkerRequest,
      { readonly type: "cancel" }
    >

    return new Promise<Result>((resolve, reject) => {
      const pendingCall: PendingCall = {
        resolve: (result) => resolve(result as Result),
        reject,
        ...(callOptions?.onProgress ? { onProgress: callOptions.onProgress } : {}),
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      }
      if (callOptions?.signal) {
        pendingCall.onAbort = () => {
          endpoint.postMessage({ type: "cancel", id } satisfies IdmlWorkerRequest)
          clearPending(id)?.reject(abortError(callOptions.signal!))
        }
        callOptions.signal.addEventListener("abort", pendingCall.onAbort, { once: true })
      }
      pending.set(id, pendingCall)
      try {
        endpoint.postMessage(message, [bytes])
      } catch (error) {
        clearPending(id)
        reject(error)
      }
    })
  }

  return {
    inspect: (bytes, callOptions) => call<IdmlPackageInspection>({
      method: "inspect",
      ...(callOptions?.limits ? { limits: callOptions.limits } : {}),
    }, bytes, callOptions),
    parse: (bytes, profile = "generic", callOptions) => call<IdmlParseResult>({
      method: "parse",
      profile,
      ...(callOptions?.limits ? { limits: callOptions.limits } : {}),
    }, bytes, callOptions),
    export: (bytes, translations, callOptions) => call<IdmlExportResult>({
      method: "export",
      translations,
      ...(callOptions?.limits ? { limits: callOptions.limits } : {}),
    }, bytes, callOptions),
    validate: (bytes, manifest, callOptions) => call<readonly IdmlDiagnostic[]>({
      method: "validate",
      manifest,
      ...(callOptions?.limits ? { limits: callOptions.limits } : {}),
    }, bytes, callOptions),
    dispose: () => {
      if (disposed) return
      disposed = true
      rejectAll(new Error("IDML worker client has been disposed"))
      if (worker) {
        worker.removeEventListener("message", onMessage as EventListener)
        worker.removeEventListener("error", onError as EventListener)
        worker.terminate()
      }
    },
  }
}

async function oneShot<Result>(
  run: (client: IdmlWorkerClient) => Promise<Result>,
  options?: CreateIdmlWorkerClientOptions,
): Promise<Result> {
  const client = createIdmlWorkerClient(options)
  try {
    return await run(client)
  } finally {
    client.dispose()
  }
}

export function inspectIdmlInWorker(
  bytes: ArrayBuffer,
  options?: IdmlWorkerCallOptions,
  clientOptions?: CreateIdmlWorkerClientOptions,
): Promise<IdmlPackageInspection> {
  return oneShot((client) => client.inspect(bytes, options), clientOptions)
}

export function parseIdmlInWorker(
  bytes: ArrayBuffer,
  profile: "generic" | "biblica" = "generic",
  options?: IdmlWorkerCallOptions,
  clientOptions?: CreateIdmlWorkerClientOptions,
): Promise<IdmlParseResult> {
  return oneShot((client) => client.parse(bytes, profile, options), clientOptions)
}

export function exportIdmlInWorker(
  bytes: ArrayBuffer,
  translations: readonly IdmlTranslation[],
  options?: IdmlWorkerCallOptions,
  clientOptions?: CreateIdmlWorkerClientOptions,
): Promise<IdmlExportResult> {
  return oneShot((client) => client.export(bytes, translations, options), clientOptions)
}

export function validateIdmlExportInWorker(
  bytes: ArrayBuffer,
  manifest: IdmlSourceManifest,
  options?: IdmlWorkerCallOptions,
  clientOptions?: CreateIdmlWorkerClientOptions,
): Promise<readonly IdmlDiagnostic[]> {
  return oneShot((client) => client.validate(bytes, manifest, options), clientOptions)
}
