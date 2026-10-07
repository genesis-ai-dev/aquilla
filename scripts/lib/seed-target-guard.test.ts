import { describe, expect, it } from "vitest"
import { assertSeedTargetAllowed, CONFIRM_FLAG } from "./seed-target-guard"

const LOCAL = "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"
const PROD = "postgresql://neondb_owner:pw@ep-prod-abc123.us-east-2.aws.neon.tech/neondb"
const DEV_BRANCH = "postgresql://neondb_owner:pw@ep-dev-xyz789.us-east-2.aws.neon.tech/neondb"

const argvLocal = ["node", "seed-load.ts", "--local"]
const argvTarget = (url: string, ...rest: string[]) => ["node", "seed-load.ts", "--target", url, ...rest]

describe("assertSeedTargetAllowed", () => {
  it("allows loopback targets with no env and no flags", () => {
    expect(assertSeedTargetAllowed({ url: LOCAL, env: {}, argv: argvLocal })).toBe("127.0.0.1")
    for (const host of ["localhost", "0.0.0.0"]) {
      const url = `postgresql://u:p@${host}:5432/aquilla_dev`
      expect(assertSeedTargetAllowed({ url, env: {}, argv: argvLocal })).toBe(host)
    }
    // IPv6 literals stay bracketed through `new URL()`.
    expect(
      assertSeedTargetAllowed({ url: "postgresql://u:p@[::1]:5432/aquilla_dev", env: {}, argv: argvLocal }),
    ).toBe("[::1]")
  })

  // THE AQU-750 REGRESSION GUARD. The old guard read
  //   `process.env.NEON_PG_HOST && host === process.env.NEON_PG_HOST`
  // so with NEON_PG_HOST unset — a fresh checkout, or any shell that never
  // sourced .env — a `--target <prod>` run sailed straight through and the
  // loader DELETEd live production rows before re-inserting a day-old bundle.
  // A remote target must now be refused when nothing proves it is safe.
  it("refuses a remote target when the environment declares no production host", () => {
    expect(() => assertSeedTargetAllowed({ url: PROD, env: {}, argv: argvTarget(PROD) })).toThrow(
      /refusing to load into remote host ep-prod-abc123\.us-east-2\.aws\.neon\.tech/,
    )
  })

  // The same fail-open path, reached the other way: neon-target.ts and
  // refresh-neon-branch.ts both reassign NEON_PG_HOST to whichever branch they
  // are driving, so an ambient value is no evidence that the target is safe.
  it("refuses a remote target when NEON_PG_HOST points at some other host", () => {
    expect(() =>
      assertSeedTargetAllowed({
        url: PROD,
        env: { NEON_PG_HOST: "ep-dev-xyz789.us-east-2.aws.neon.tech" },
        argv: argvTarget(PROD),
      }),
    ).toThrow(/refusing to load into remote host/)
  })

  it("names the confirmation flag so the operator can opt a non-prod branch in", () => {
    expect(() => assertSeedTargetAllowed({ url: DEV_BRANCH, env: {}, argv: argvTarget(DEV_BRANCH) })).toThrow(
      new RegExp(`${CONFIRM_FLAG} ep-dev-xyz789\\.us-east-2\\.aws\\.neon\\.tech`),
    )
  })

  it("allows a remote target the operator re-types exactly", () => {
    const host = "ep-dev-xyz789.us-east-2.aws.neon.tech"
    expect(
      assertSeedTargetAllowed({
        url: DEV_BRANCH,
        env: {},
        argv: argvTarget(DEV_BRANCH, CONFIRM_FLAG, host),
      }),
    ).toBe(host)
  })

  it("refuses when the confirmation names a different host than the target", () => {
    expect(() =>
      assertSeedTargetAllowed({
        url: PROD,
        env: {},
        argv: argvTarget(PROD, CONFIRM_FLAG, "ep-dev-xyz789.us-east-2.aws.neon.tech"),
      }),
    ).toThrow(/refusing to load into remote host/)
  })

  it("refuses when the confirmation flag is passed with no value", () => {
    expect(() =>
      assertSeedTargetAllowed({ url: PROD, env: {}, argv: argvTarget(PROD, CONFIRM_FLAG) }),
    ).toThrow(/refusing to load into remote host/)
  })

  // The legacy deny still stands, and confirmation cannot unlock it: a host
  // the operator has declared production is never a valid seed target.
  it.each(["AQUILLA_PROD_PG_HOST", "NEON_PG_HOST"])(
    "refuses a host declared production via %s, even when confirmed",
    (varName) => {
      const host = "ep-prod-abc123.us-east-2.aws.neon.tech"
      expect(() =>
        assertSeedTargetAllowed({
          url: PROD,
          env: { [varName]: host },
          argv: argvTarget(PROD, CONFIRM_FLAG, host),
        }),
      ).toThrow(`refusing to load into prod host ${host}`)
    },
  )

  it("matches the production host case-insensitively", () => {
    expect(() =>
      assertSeedTargetAllowed({
        url: PROD,
        env: { NEON_PG_HOST: "EP-PROD-ABC123.US-EAST-2.AWS.NEON.TECH" },
        argv: argvTarget(PROD),
      }),
    ).toThrow(/refusing to load into prod host/)
  })

  it("refuses a target that is not a parseable connection URL", () => {
    expect(() =>
      assertSeedTargetAllowed({ url: "not-a-url", env: {}, argv: argvTarget("not-a-url") }),
    ).toThrow(/not a valid connection URL/)
  })
})
