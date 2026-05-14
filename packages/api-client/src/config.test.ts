import { describe, expect, it } from "vitest"
import { DEFAULT_AUTH_API_URL } from "./config"

describe("api-client config", () => {
  it("defaults to the same frontier-server backend used by auth-client", () => {
    expect(DEFAULT_AUTH_API_URL).toBe(
      "https://aquilla-frontier-server.blue-darkness-7674.workers.dev",
    )
  })
})
