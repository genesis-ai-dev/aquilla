import { describe, expect, it } from "vitest"
import {
  DEFAULT_APP_ORIGIN,
  DEFAULT_AUTH_BASE,
  DEFAULT_LOAD_BUDGET_MS,
  DEFAULT_WRITE_BUDGET_MS,
  describeProductionTimingTarget,
  resolveProductionTimingTarget,
} from "../e2e/helpers/production-target"

const configured = {
  AQUILLA_PROD_USERNAME: "timing-probe",
  AQUILLA_PROD_PASSWORD: "s3cret",
  AQUILLA_PROD_PROJECT_ID: "11111111-2222-3333-4444-555555555555",
}

describe("resolveProductionTimingTarget", () => {
  it("defaults the deployed origins and the documented budgets", () => {
    const target = resolveProductionTimingTarget({ ...configured })

    expect(target.appOrigin).toBe(DEFAULT_APP_ORIGIN)
    expect(target.authBase).toBe(DEFAULT_AUTH_BASE)
    expect(target.loadBudgetMs).toBe(DEFAULT_LOAD_BUDGET_MS)
    expect(target.writeBudgetMs).toBe(DEFAULT_WRITE_BUDGET_MS)
    expect(target.projectId).toBe(configured.AQUILLA_PROD_PROJECT_ID)
  })

  it("names every missing credential in a single error", () => {
    let message = ""
    try {
      resolveProductionTimingTarget({})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain("AQUILLA_PROD_USERNAME")
    expect(message).toContain("AQUILLA_PROD_PASSWORD")
    expect(message).toContain("AQUILLA_PROD_PROJECT_ID")
  })

  it("treats whitespace-only values as missing", () => {
    expect(() =>
      resolveProductionTimingTarget({ ...configured, AQUILLA_PROD_PROJECT_ID: "   " }),
    ).toThrow(/AQUILLA_PROD_PROJECT_ID/)
  })

  it("accepts overridden origins and strips their trailing slash", () => {
    const target = resolveProductionTimingTarget({
      ...configured,
      AQUILLA_PROD_APP_ORIGIN: "https://dev.aquilla.app/",
      AQUILLA_PROD_AUTH_BASE: "https://api.dev.aquilla.app/identity/",
    })

    expect(target.appOrigin).toBe("https://dev.aquilla.app")
    expect(target.authBase).toBe("https://api.dev.aquilla.app/identity")
  })

  it("rejects an origin that is not an absolute http(s) URL", () => {
    expect(() =>
      resolveProductionTimingTarget({ ...configured, AQUILLA_PROD_APP_ORIGIN: "aquilla.app" }),
    ).toThrow(/AQUILLA_PROD_APP_ORIGIN/)
    expect(() =>
      resolveProductionTimingTarget({ ...configured, AQUILLA_PROD_APP_ORIGIN: "ftp://aquilla.app" }),
    ).toThrow(/AQUILLA_PROD_APP_ORIGIN/)
  })

  it("honours explicit budgets", () => {
    const target = resolveProductionTimingTarget({
      ...configured,
      AQUILLA_PROD_LOAD_BUDGET_MS: "4000",
      AQUILLA_PROD_WRITE_BUDGET_MS: "1500",
    })

    expect(target.loadBudgetMs).toBe(4_000)
    expect(target.writeBudgetMs).toBe(1_500)
  })

  it("refuses a malformed budget instead of silently using the default", () => {
    // A tightened budget that quietly reverts to 15s would hide the regression
    // it was tightened to catch, so this must fail loudly.
    for (const bad of ["1_500", "1.5", "abc", "-200", "0"]) {
      expect(() =>
        resolveProductionTimingTarget({ ...configured, AQUILLA_PROD_LOAD_BUDGET_MS: bad }),
      ).toThrow(/AQUILLA_PROD_LOAD_BUDGET_MS/)
    }
  })

  it("tells the operator the target project must be reserved for the probe", () => {
    let message = ""
    try {
      resolveProductionTimingTarget({})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain("Never aim it at customer data")
  })
})

describe("describeProductionTimingTarget", () => {
  it("summarises the run without leaking the password", () => {
    const summary = describeProductionTimingTarget(
      resolveProductionTimingTarget({ ...configured }),
    )

    expect(summary).toContain(DEFAULT_APP_ORIGIN)
    expect(summary).toContain(configured.AQUILLA_PROD_PROJECT_ID)
    expect(summary).toContain(configured.AQUILLA_PROD_USERNAME)
    expect(summary).not.toContain(configured.AQUILLA_PROD_PASSWORD)
  })
})
