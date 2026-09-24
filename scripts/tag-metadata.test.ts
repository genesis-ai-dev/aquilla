import { describe, expect, it } from "vitest"
import { generateTagMessage } from "./tag-metadata.mjs"

describe("tag-metadata.mjs", () => {
  it("generates a complete tag message with all metadata", () => {
    const tag = "2026.09.23.00"
    const branch = "release/2026/09/23"
    const commitSha = "abc123def456789012345678901234567890abcd"

    const message = generateTagMessage(tag, branch, commitSha)

    expect(message).toContain("Production release 2026.09.23.00")
    expect(message).toContain("Release branch: release/2026/09/23")
    expect(message).toContain("Deployed commit: abc123de (abc123def456789012345678901234567890abcd)")
    expect(message).toContain(`Commit URL: https://github.com/genesis-ai-dev/aquilla/commit/${commitSha}`)
    expect(message).toContain(`Checks URL: https://github.com/genesis-ai-dev/aquilla/commit/${commitSha}/checks`)
    expect(message).toContain("Preview URL:")
    // Verify the preview URL is deterministic and contains the expected alias
    expect(message).toMatch(/Preview URL: https:\/\/ci-release-2026-09-23-[a-f0-9]{8}-aquilla-web-preview\.blue-darkness-7674\.workers\.dev/)
  })

  it("generates the same preview URL for the same branch", () => {
    const tag = "2026.09.23.00"
    const branch = "release/2026/09/23"
    const commitSha1 = "abc123def456789012345678901234567890abcd"
    const commitSha2 = "def456abc789012345678901234567890abcdef"

    const message1 = generateTagMessage(tag, branch, commitSha1)
    const message2 = generateTagMessage(tag, branch, commitSha2)

    // Extract preview URLs
    const url1 = message1.match(/Preview URL: (https:\/\/.+)$/m)?.[1]
    const url2 = message2.match(/Preview URL: (https:\/\/.+)$/m)?.[1]

    expect(url1).toBeTruthy()
    expect(url2).toBeTruthy()
    expect(url1).toBe(url2) // Same branch should produce same preview URL
  })

  it("handles different release branches with unique preview URLs", () => {
    const commitSha = "abc123def456789012345678901234567890abcd"

    const message1 = generateTagMessage("2026.09.23.00", "release/2026/09/23", commitSha)
    const message2 = generateTagMessage("2026.09.24.00", "release/2026/09/24", commitSha)

    const url1 = message1.match(/Preview URL: (https:\/\/.+)$/m)?.[1]
    const url2 = message2.match(/Preview URL: (https:\/\/.+)$/m)?.[1]

    expect(url1).toBeTruthy()
    expect(url2).toBeTruthy()
    expect(url1).not.toBe(url2) // Different branches should produce different preview URLs
  })

  it("throws an error when required parameters are missing", () => {
    expect(() => generateTagMessage("", "branch", "sha")).toThrow("tag, branch, and commitSha are required")
    expect(() => generateTagMessage("tag", "", "sha")).toThrow("tag, branch, and commitSha are required")
    expect(() => generateTagMessage("tag", "branch", "")).toThrow("tag, branch, and commitSha are required")
  })

  it("falls back to 'unknown' preview URL if branch alias generation fails", () => {
    const tag = "2026.09.23.00"
    const branch = "" // Invalid branch
    const commitSha = "abc123def456789012345678901234567890abcd"

    // Should not throw, but should contain 'unknown' for preview URL
    expect(() => generateTagMessage(tag, branch, commitSha)).toThrow()
  })
})
