import { describe, it, expect } from "vitest"
import {
  hashPasswordWerkzeugScrypt,
  isBcryptHash,
  isWerkzeugScryptHash,
  parseWerkzeugScryptHash,
  verifyPassword,
} from "../utils/password"

describe("werkzeug-scrypt password format", () => {
  it("hashes round-trip via verifyPassword", async () => {
    const stored = await hashPasswordWerkzeugScrypt("hunter22")
    expect(isWerkzeugScryptHash(stored)).toBe(true)
    const ok = await verifyPassword("hunter22", stored)
    expect(ok.isValid).toBe(true)
    expect(ok.shouldRehashToWerkzeugScrypt).toBe(false)
  })

  it("rejects the wrong password", async () => {
    const stored = await hashPasswordWerkzeugScrypt("correct")
    const result = await verifyPassword("incorrect", stored)
    expect(result.isValid).toBe(false)
  })

  it("parses the legacy `scrypt:N:r:p$salt$hex` format", async () => {
    const stored = await hashPasswordWerkzeugScrypt("pw", {
      N: 32768,
      r: 8,
      p: 1,
    })
    const parsed = parseWerkzeugScryptHash(stored)
    expect(parsed.params).toEqual({ N: 32768, r: 8, p: 1 })
    expect(parsed.salt.length).toBeGreaterThan(0)
    expect(parsed.digestHex.length).toBe(128)
  })

  it("flags non-scrypt non-bcrypt input as unsupported", async () => {
    await expect(verifyPassword("pw", "plain-text-pw")).rejects.toThrow(
      /Unsupported password hash/,
    )
  })

  it("detects bcrypt hashes via the prefix check", () => {
    expect(isBcryptHash("$2b$12$saltsaltsaltsaltsaltsa.hashhashhashhashhashhashhashh")).toBe(true)
    expect(isBcryptHash("scrypt:32768:8:1$salt$abc")).toBe(false)
  })
})
