import { decodeBase64, encodeBase64 } from "./base64"
import type { ResolveSandbox, SandboxLike, SandboxRunResult } from "./sandbox"
import type { RunCodeOptions } from "./sandbox-do"

/**
 * The RPC surface of our `Sandbox` Durable Object (sandbox-do.ts) as the Worker
 * sees it through `env.Sandbox.getByName()`. Byte-oriented on purpose: files
 * cross the stub as streams, which RPC flow-controls and which are exempt from
 * its 32 MiB message cap (a `/files` upload may be 25 MB decoded). Declared
 * here so the adapter below is unit-testable with a plain object.
 */
export interface SandboxRpc {
  runCode(code: string, options: RunCodeOptions): Promise<SandboxRunResult>
  writeFile(path: string, content: ReadableStream<Uint8Array>): Promise<void>
  readFile(path: string): Promise<ReadableStream<Uint8Array> | null>
  destroy(): Promise<void>
}

const encoder = new TextEncoder()

/** A byte-source stream — the only kind RPC streams. An empty chunk is illegal on one, hence the guard. */
function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    type: "bytes",
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Present the Durable Object's RPC methods as the `SandboxLike` the routes are
 * written against (sandbox.ts), so app.ts and its tests did not have to change
 * for the SDK migration: base64 in/out stays at this boundary, `timeout` becomes
 * `timeoutMs`, and the worker-side `AbortSignal` never crosses the stub (the
 * container enforces the deadline itself — see container-exec.ts).
 */
export function sandboxAdapter(stub: SandboxRpc): SandboxLike {
  return {
    runCode: (code, options) =>
      stub.runCode(code, { language: options?.language, timeoutMs: options?.timeout }),

    async writeFile(path, content, options) {
      const bytes = options?.encoding === "base64" ? decodeBase64(content) : encoder.encode(content)
      await stub.writeFile(path, byteStream(bytes))
      return { success: true, path }
    },

    async readFile(path, options) {
      const body = await stub.readFile(path)
      if (!body) return { success: false, path, content: "" }
      const bytes = new Uint8Array(await new Response(body).arrayBuffer())
      const binary = options?.encoding === "base64"
      return {
        success: true,
        path,
        content: binary ? encodeBase64(bytes) : new TextDecoder().decode(bytes),
        encoding: binary ? "base64" : "utf-8",
        isBinary: binary,
        size: bytes.length,
      }
    },

    destroy: () => stub.destroy(),
  }
}

/**
 * Production resolver — one container Durable Object instance per sessionId.
 * `getByName` replaces the 0.x `getSandbox(ns, id)`; the stub's methods are the
 * ones `Sandbox` defines, nothing more.
 */
export const resolveSandbox: ResolveSandbox = (env, sessionId) =>
  sandboxAdapter(env.Sandbox.getByName(sessionId))
