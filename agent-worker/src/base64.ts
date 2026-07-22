import { ApiError } from "./errors"

/** Decode base64 → bytes, rejecting malformed input as validation_failed. */
export function decodeBase64(b64: string): Uint8Array {
  let binary: string
  try {
    binary = atob(b64)
  } catch {
    throw new ApiError("validation_failed", "contentBase64 is not valid base64")
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Encode bytes → base64 in fixed-size chunks (avoids call-stack limits). */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
