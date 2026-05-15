import { describe, it, expect, beforeEach } from "vitest"
import {
  COOKIE_NAME,
  deriveCookieDomain,
  setJwt,
  getJwt,
  clearJwt,
} from "./cookie"

describe("deriveCookieDomain", () => {
  it("returns null for localhost", () => {
    expect(deriveCookieDomain("localhost")).toBeNull()
  })

  it("returns null for raw IPv4", () => {
    expect(deriveCookieDomain("127.0.0.1")).toBeNull()
  })

  it("returns null for single-label host", () => {
    expect(deriveCookieDomain("myhost")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(deriveCookieDomain("")).toBeNull()
  })

  it("returns leading-dot bare domain for 2-label host", () => {
    expect(deriveCookieDomain("aquilla.app")).toBe(".aquilla.app")
  })

  it("strips subdomain for 3+ label host", () => {
    expect(deriveCookieDomain("dev.aquilla.app")).toBe(".aquilla.app")
    expect(deriveCookieDomain("pr-7.aquilla.app")).toBe(".aquilla.app")
  })

  it("keeps the project label for pages.dev hosts", () => {
    expect(deriveCookieDomain("foo.aquilla-web-4ih.pages.dev")).toBe(
      ".aquilla-web-4ih.pages.dev",
    )
    expect(deriveCookieDomain("aquilla-web-4ih.pages.dev")).toBe(
      ".aquilla-web-4ih.pages.dev",
    )
  })
})

// Fake document we control across tests.
function makeDoc() {
  return { cookie: "" }
}

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encodedPayload = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `header.${encodedPayload}.signature`
}

describe("setJwt / getJwt / clearJwt", () => {
  let doc: { cookie: string }

  beforeEach(() => {
    doc = makeDoc()
  })

  it("writes cookie with the JWT name and value", () => {
    setJwt("abc.def.ghi", { doc, hostname: "localhost", secure: false })
    expect(doc.cookie).toContain(`${COOKIE_NAME}=abc.def.ghi`)
    expect(doc.cookie).toContain("Path=/")
    expect(doc.cookie).toContain("SameSite=Lax")
    expect(doc.cookie).toContain("Max-Age=")
  })

  it("omits Domain when on localhost", () => {
    setJwt("t", { doc, hostname: "localhost", secure: false })
    expect(doc.cookie).not.toContain("Domain=")
  })

  it("sets parent-domain Domain attribute when on a subdomain", () => {
    setJwt("t", { doc, hostname: "pr-3.aquilla.app", secure: true })
    expect(doc.cookie).toContain("Domain=.aquilla.app")
    expect(doc.cookie).toContain("Secure")
  })

  it("sets pages.dev project-level Domain", () => {
    setJwt("t", { doc, hostname: "preview.aquilla-web-4ih.pages.dev", secure: true })
    expect(doc.cookie).toContain("Domain=.aquilla-web-4ih.pages.dev")
  })

  it("URL-encodes JWT bytes that would break the header", () => {
    // Real JWTs are base64url and don't need encoding, but the function
    // shouldn't choke on a value that does.
    setJwt("a b;c", { doc, hostname: "localhost", secure: false })
    expect(doc.cookie).toContain(`${COOKIE_NAME}=a%20b%3Bc`)
  })

  it("getJwt reads what setJwt wrote (simulating browser)", () => {
    // Simulate the browser: after setJwt, the document's cookie header
    // would echo back JUST `name=value`.
    doc.cookie = `${COOKIE_NAME}=hello.world`
    expect(getJwt({ doc })).toBe("hello.world")
  })

  it("getJwt returns null when cookie absent", () => {
    doc.cookie = "other=thing"
    expect(getJwt({ doc })).toBeNull()
  })

  it("getJwt returns null when cookie is empty value", () => {
    doc.cookie = `${COOKIE_NAME}=`
    expect(getJwt({ doc })).toBeNull()
  })

  it("getJwt decodes URL-encoded values", () => {
    doc.cookie = `${COOKIE_NAME}=a%20b`
    expect(getJwt({ doc })).toBe("a b")
  })

  it("getJwt picks the newest JWT when duplicate cookie variants exist", () => {
    const olderLonger = jwtWithPayload({ sub: "alice", iat: 100, extra: "x".repeat(80) })
    const newerShorter = jwtWithPayload({ sub: "alice", iat: 200 })
    doc.cookie = `${COOKIE_NAME}=${olderLonger}; ${COOKIE_NAME}=${newerShorter}`

    expect(getJwt({ doc })).toBe(newerShorter)
  })

  it("getJwt falls back to longest value when iat is unavailable", () => {
    doc.cookie = `${COOKIE_NAME}=short; ${COOKIE_NAME}=much-longer`

    expect(getJwt({ doc })).toBe("much-longer")
  })

  it("clearJwt writes Max-Age=0", () => {
    clearJwt({ doc, hostname: "localhost" })
    expect(doc.cookie).toContain("Max-Age=0")
    expect(doc.cookie).toContain(`${COOKIE_NAME}=`)
  })

  it("clearJwt includes Domain on subdomain hosts so the browser overwrites", () => {
    clearJwt({ doc, hostname: "pr-7.aquilla.app" })
    expect(doc.cookie).toContain("Domain=.aquilla.app")
  })
})
