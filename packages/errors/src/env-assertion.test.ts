import { describe, expect, it } from "vitest"
import {
  assertEnvBindings,
  assertNotPreviewInProd,
  isBindingNameValid,
} from "./env-assertion"

describe("isBindingNameValid", () => {
  it("accepts prod names with the aquilla-prod- prefix", () => {
    expect(isBindingNameValid("aquilla-prod-db", "prod")).toBe(true)
    expect(isBindingNameValid("aquilla-prod-snapshots", "prod")).toBe(true)
  })

  it("rejects prod names without the aquilla-prod- prefix", () => {
    expect(isBindingNameValid("aquilla-db", "prod")).toBe(false)
    expect(isBindingNameValid("aquilla-pr-42-db", "prod")).toBe(false)
    expect(isBindingNameValid("aquilla-dev", "prod")).toBe(false)
  })

  it("accepts preview names with the aquilla-pr- prefix or aquilla-dev", () => {
    expect(isBindingNameValid("aquilla-pr-42-db", "preview")).toBe(true)
    expect(isBindingNameValid("aquilla-pr-99-snapshots", "preview")).toBe(true)
    expect(isBindingNameValid("aquilla-dev", "preview")).toBe(true)
    expect(isBindingNameValid("aquilla-dev-db", "preview")).toBe(true)
  })

  it("rejects preview names with the prod prefix", () => {
    expect(isBindingNameValid("aquilla-prod-db", "preview")).toBe(false)
  })

  it("rejects unknown env values", () => {
    expect(isBindingNameValid("aquilla-prod-db", "staging")).toBe(false)
    expect(isBindingNameValid("aquilla-dev", "")).toBe(false)
  })
})

describe("assertEnvBindings", () => {
  it("passes when every named binding matches the expected env", () => {
    const env = {
      ENV: "prod",
      DB: { name: "aquilla-prod-db" },
      SNAPSHOTS: { name: "aquilla-prod-snapshots" },
      // Non-binding values are ignored.
      JWT_SECRET: "secret",
      MAX_AGE: 3600,
    }
    expect(() => assertEnvBindings(env, "prod")).not.toThrow()
  })

  it("throws when a binding name mismatches the env convention", () => {
    const env = {
      ENV: "prod",
      DB: { name: "aquilla-pr-42-db" }, // wrong: preview name in prod
    }
    expect(() => assertEnvBindings(env, "prod")).toThrow(
      /Binding "DB" has name "aquilla-pr-42-db"/,
    )
  })

  it("throws on unknown env values", () => {
    expect(() => assertEnvBindings({}, "staging")).toThrow(/Unknown ENV/)
  })

  it("ignores bindings without a string `name` property", () => {
    const env = {
      ENV: "preview",
      QUEUE: { send: () => {} }, // no .name field — ignored.
      DB: { name: "aquilla-pr-1-db" },
    }
    expect(() => assertEnvBindings(env, "preview")).not.toThrow()
  })

  it("accepts the shared aquilla-dev DB in preview", () => {
    const env = {
      ENV: "preview",
      DB: { name: "aquilla-dev" },
    }
    expect(() => assertEnvBindings(env, "preview")).not.toThrow()
  })
})

describe("assertNotPreviewInProd", () => {
  it("passes for prod env on the prod hostname", () => {
    expect(() =>
      assertNotPreviewInProd({ ENV: "prod" }, "aquilla.app"),
    ).not.toThrow()
  })

  it("passes for preview env on a preview hostname", () => {
    expect(() =>
      assertNotPreviewInProd({ ENV: "preview" }, "pr-42.aquilla.app"),
    ).not.toThrow()
  })

  it("throws for preview env on the prod hostname", () => {
    expect(() =>
      assertNotPreviewInProd({ ENV: "preview" }, "aquilla.app"),
    ).toThrow(/ENV=preview but request hostname is the production domain/)
  })

  it("throws for preview env on www.aquilla.app by default", () => {
    expect(() =>
      assertNotPreviewInProd({ ENV: "preview" }, "www.aquilla.app"),
    ).toThrow()
  })

  it("respects a caller-supplied production-hosts set", () => {
    expect(() =>
      assertNotPreviewInProd(
        { ENV: "preview" },
        "api.aquilla.app",
        new Set(["api.aquilla.app"]),
      ),
    ).toThrow()
  })

  it("throws if env.ENV is missing or not a string", () => {
    expect(() => assertNotPreviewInProd({}, "aquilla.app")).toThrow(
      /env\.ENV is not a string/,
    )
    expect(() =>
      assertNotPreviewInProd({ ENV: 7 as unknown as string }, "aquilla.app"),
    ).toThrow(/env\.ENV is not a string/)
  })
})
