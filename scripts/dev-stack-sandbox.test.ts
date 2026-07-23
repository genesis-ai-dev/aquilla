import { describe, expect, it } from "vitest"
import {
  readDevVar,
  resolveConfiguredAgentSandbox,
} from "./dev-stack-sandbox"

describe("dev-stack sandbox configuration", () => {
  it("reads quoted and unquoted Wrangler dev vars", () => {
    const source = [
      'AGENT_SANDBOX_URL="https://sandbox.example.test/"',
      "AGENT_SANDBOX_KEY='secret-value'",
    ].join("\n")

    expect(readDevVar(source, "AGENT_SANDBOX_URL")).toBe(
      "https://sandbox.example.test/",
    )
    expect(readDevVar(source, "AGENT_SANDBOX_KEY")).toBe("secret-value")
  })

  it("returns null when no remote sandbox is configured", () => {
    expect(resolveConfiguredAgentSandbox({})).toBeNull()
  })

  it("uses process values ahead of persistent dev vars", () => {
    const result = resolveConfiguredAgentSandbox(
      {
        AGENT_SANDBOX_URL: "https://process.example.test/",
        AGENT_SANDBOX_KEY: "process-key",
      },
      [
        "AGENT_SANDBOX_URL=https://file.example.test",
        "AGENT_SANDBOX_KEY=file-key",
      ].join("\n"),
    )

    expect(result).toEqual({
      url: "https://process.example.test",
      key: "process-key",
    })
  })

  it("rejects a half-configured endpoint", () => {
    expect(() =>
      resolveConfiguredAgentSandbox({
        AGENT_SANDBOX_URL: "https://sandbox.example.test",
      }),
    ).toThrow("must be configured together")
  })

  it("does not mix a process override with a persisted credential", () => {
    expect(() =>
      resolveConfiguredAgentSandbox(
        { AGENT_SANDBOX_URL: "https://process.example.test" },
        [
          "AGENT_SANDBOX_URL=https://file.example.test",
          "AGENT_SANDBOX_KEY=file-key",
        ].join("\n"),
      ),
    ).toThrow("must be configured together")
  })

  it("rejects non-http endpoints", () => {
    expect(() =>
      resolveConfiguredAgentSandbox({
        AGENT_SANDBOX_URL: "file:///tmp/sandbox",
        AGENT_SANDBOX_KEY: "secret-value",
      }),
    ).toThrow("must use http or https")
  })
})
