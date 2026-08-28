// AQU-1005: the /migrate/* fence requires every run to identify itself via
// x-migrate-runner. Blocking anonymous runners (503) is what locates legacy
// automation still holding SYNC_SECRET_KEY without rotating the secret.

import { describe, it, expect } from "vitest"
import { migrateFenceResponse, MIGRATE_RUNNER_HEADER } from "../lib/migrate-fence"

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext

describe("migrateFenceResponse (AQU-1005)", () => {
  it("ignores non-migrate paths", () => {
    const req = new Request("https://sync.test/events", { method: "POST" })
    expect(migrateFenceResponse(req, {}, ctx)).toBeNull()
  })

  it("blocks /migrate/* without the runner header and says how to proceed", async () => {
    const req = new Request("https://sync.test/migrate/ingest", { method: "POST" })
    const res = migrateFenceResponse(req, {}, ctx)
    expect(res?.status).toBe(503)
    expect(await res!.text()).toContain(MIGRATE_RUNNER_HEADER)
  })

  it("passes /migrate/* through when the runner identifies itself", () => {
    const req = new Request("https://sync.test/migrate/event-ids?projectId=p", {
      headers: { [MIGRATE_RUNNER_HEADER]: "ryder@laptop" },
    })
    expect(migrateFenceResponse(req, {}, ctx)).toBeNull()
  })
})
