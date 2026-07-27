import { IdmlError } from "./errors.js"

export async function sha256(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new IdmlError(
      "EXPORT_REJECTED",
      "SHA-256 is unavailable in this runtime; Web Crypto support is required",
    )
  }
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const input = new Uint8Array(source.byteLength)
  input.set(source)
  const digest = await subtle.digest("SHA-256", input)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function sha256Text(value: string): Promise<string> {
  return sha256(new TextEncoder().encode(value))
}
