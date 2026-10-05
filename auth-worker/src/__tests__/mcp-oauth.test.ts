// MCP OAuth (authorization code + PKCE) → the existing API-credential consumer.
//
// The contract: an MCP host such as ChatGPT discovers this server, sends the
// human through consent, and redeems a code for an `aqk_` credential that the
// Agent API accepts — scoped to exactly what the human approved, revocable from
// the API tokens page, and never mintable without a matching PKCE verifier.
// The sync-worker half (401 challenge + RFC 9728 metadata) is covered in
// sync-worker/src/__tests__/external-mcp-oauth.test.ts.
import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { OAUTH_ORG_ALLOWLIST_FLOOR, validateApiCredential } from "../../../db/shared/api-credentials"
import { ROLE } from "../types"

import { listOrgsForCredential } from "../../../sync-worker/src/external/orgs-list"
import { listProjectsForCredential } from "../../../sync-worker/src/external/projects-list"
import { scopeCredentialToProject } from "../../../sync-worker/src/external/read-auth"
import { assertCredentialScope } from "../../../sync-worker/src/external/token-bridge"

const ISSUER = "https://api.aquilla.app/identity"
const CLIENT_ID = "https://chatgpt.com/oauth/client.json"
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect"
const RESOURCE = "https://api.aquilla.app/sync/api/v1/external/mcp"
const VERIFIER = "v".repeat(20) + "-._~" + "0123456789abcdefghij"

const oauthEnv = Object.assign(Object.create(env) as typeof env, {
  MCP_OAUTH_ISSUER: ISSUER,
  BASE_URL: "https://aquilla.app",
})

async function challengeFor(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** What ChatGPT puts on /oauth/authorize, as the SPA posts it back. */
async function authorizeParams(overrides: Record<string, string | undefined> = {}) {
  return {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: await challengeFor(VERIFIER),
    code_challenge_method: "S256",
    state: "xyz-state",
    scope: "ask",
    resource: RESOURCE,
    ...overrides,
  }
}

let clientDocument: Record<string, unknown>
const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  return url === CLIENT_ID ? Response.json(clientDocument) : new Response("not found", { status: 404 })
})

beforeEach(() => {
  clientDocument = { client_id: CLIENT_ID, client_name: "ChatGPT", redirect_uris: [REDIRECT] }
  fetchSpy.mockClear()
  vi.stubGlobal("fetch", fetchSpy)
})
afterEach(() => vi.unstubAllGlobals())

async function consent(path: "request" | "decision", body: object, jwt: string) {
  return app.request(`/api/v2/mcp-oauth/${path}`, {
    method: "POST", headers: authHeader(jwt), body: JSON.stringify(body),
  }, oauthEnv)
}

/** Token request the way OAuth clients send it: form-encoded. */
async function redeem(fields: Record<string, string>) {
  return app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }, oauthEnv)
}

async function seed() {
  await seedUser(1, "alice"); await seedUser(2, "bob")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Alpha', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by, org_id) VALUES ('p', 'Project', 1, 10)").run()
  return jwtFor("alice")
}

/** Approve as `jwt` and return the code from the redirect. */
async function approveFor(jwt: string, extra: Record<string, unknown> = {}) {
  const response = await consent("decision", { ...(await authorizeParams()), approve: true, org_ids: ["10"], ...extra }, jwt)
  expect(response.status).toBe(200)
  const redirect = new URL(((await response.json()) as { redirect: string }).redirect)
  return { redirect, code: redirect.searchParams.get("code") ?? "" }
}

const tokenFields = (code: string, overrides: Record<string, string> = {}) => ({
  grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID,
  code_verifier: VERIFIER, resource: RESOURCE, ...overrides,
})

describe("discovery", () => {
  it("serves RFC 8414 metadata at the path-issuer location and under the /identity mount", async () => {
    for (const path of ["/.well-known/oauth-authorization-server/identity", "/identity/.well-known/oauth-authorization-server"]) {
      // The /identity mount re-dispatches through app.fetch, which needs a ctx.
      const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
      const response = await app.request(path, {}, oauthEnv, ctx)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      })
    }
    // A suffix that is not this issuer's path belongs to some other issuer.
    expect((await app.request("/.well-known/oauth-authorization-server/chat", {}, oauthEnv)).status).toBe(404)
  })

  it("sends the browser to the SPA consent page with the request untouched", async () => {
    const query = new URLSearchParams(await authorizeParams()).toString()
    const response = await app.request(`/oauth/authorize?${query}`, {}, oauthEnv)
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(`https://aquilla.app/oauth/consent?${query}`)
  })
})

describe("consent → token → Agent API credential", () => {
  it("delivers one scoped credential, named after the client, revocable from API tokens", async () => {
    const jwt = await seed()
    const described = await consent("request", await authorizeParams(), jwt)
    expect(await described.json()).toEqual({
      clientName: "ChatGPT", clientHost: "chatgpt.com", redirectHost: "chatgpt.com", mode: "act", organizations: [{ id: "10", name: "Alpha" }],
    })
    const { redirect, code } = await approveFor(jwt)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT)
    expect(redirect.searchParams.get("state")).toBe("xyz-state")
    // RFC 9207: the response names its issuer, defeating mix-up attacks.
    expect(redirect.searchParams.get("iss")).toBe(ISSUER)

    const response = await redeem(tokenFields(code))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const token = (await response.json()) as { access_token: string; token_type: string; scope: string; expires_in?: number }
    expect(token).toMatchObject({ token_type: "Bearer", scope: "act" })
    expect(token.expires_in).toBeUndefined()
    expect(await validateApiCredential(env.AQUILLA_PG, token.access_token, undefined, RESOURCE))
      .toMatchObject({ userId: "1", mode: "act", projectId: null, orgId: null, orgIds: ["10"], oauthResource: RESOURCE })
    const credential = await env.AQUILLA_PG.prepare("SELECT id, name, expires_at FROM api_credentials").first<{ id: string; name: string; expires_at: null }>()
    expect(credential).toMatchObject({ name: "ChatGPT", expires_at: null })

    // Only hashes persist.
    const rows = JSON.stringify(await env.AQUILLA_PG.prepare("SELECT * FROM mcp_oauth_codes").all())
    for (const secret of [code, token.access_token, VERIFIER]) expect(rows).not.toContain(secret)

    const revoked = await app.request(`/api/v2/credentials/${credential!.id}`, { method: "DELETE", headers: authHeader(jwt) }, oauthEnv)
    expect(revoked.status).toBe(200)
    expect(await validateApiCredential(env.AQUILLA_PG, token.access_token, undefined, RESOURCE)).toBeNull()
  })

  it("treats a replayed code as a leak: refuses it and revokes the first credential", async () => {
    const jwt = await seed(); const { code } = await approveFor(jwt)
    const first = (await (await redeem(tokenFields(code))).json()) as { access_token: string }
    expect(await validateApiCredential(env.AQUILLA_PG, first.access_token, undefined, RESOURCE)).not.toBeNull()
    expect(await (await redeem(tokenFields(code))).json()).toEqual({ error: "invalid_grant" })
    expect(await validateApiCredential(env.AQUILLA_PG, first.access_token, undefined, RESOURCE)).toBeNull()
  })

  it("concurrent redemption mints at most one credential", async () => {
    const jwt = await seed(); const { code } = await approveFor(jwt)
    const responses = await Promise.all([redeem(tokenFields(code)), redeem(tokenFields(code))])
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1)
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM api_credentials WHERE revoked_at IS NULL").first())
      .toEqual({ n: 1 })
  })

  it("will not mint without the matching verifier, client and redirect", async () => {
    const jwt = await seed(); const { code } = await approveFor(jwt)
    const overrides: Record<string, string>[] = [
      { code_verifier: "w".repeat(43) },
      { client_id: "https://evil.example/client.json" },
      { redirect_uri: "https://chatgpt.com/other" },
    ]
    for (const override of overrides) {
      expect(await (await redeem(tokenFields(code, override))).json()).toEqual({ error: "invalid_grant" })
    }
    expect(await (await redeem(tokenFields(code, { resource: "https://api.aquilla.app/sync/api/v1/elsewhere" }))).json())
      .toEqual({ error: "invalid_target" })
    expect(await (await redeem(tokenFields(code, { grant_type: "refresh_token" }))).json())
      .toEqual({ error: "unsupported_grant_type" })
    // None of those attempts consumed the code.
    expect((await redeem(tokenFields(code))).status).toBe(200)
  })

  it("expires codes after five minutes", async () => {
    const jwt = await seed(); const { code } = await approveFor(jwt)
    await env.AQUILLA_PG.prepare("UPDATE mcp_oauth_codes SET expires_at = now() - interval '1 second'").run()
    expect(await (await redeem(tokenFields(code))).json()).toEqual({ error: "invalid_grant" })
  })

  it("re-checks the approver's role when the code is redeemed", async () => {
    await seed()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level) VALUES (10, 2, 600)").run()
    const { code } = await approveFor(await jwtFor("bob"))
    await env.AQUILLA_PG.prepare("DELETE FROM org_members WHERE user_id = 2").run()
    expect(await (await redeem(tokenFields(code))).json()).toEqual({ error: "invalid_grant" })
  })
})

describe("what the human approves", () => {
  it("always grants act and refuses organizations below the maintainer floor", async () => {
    await seed()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level) VALUES (10, 2, 400)").run()
    const bob = await jwtFor("bob")
    const act = await consent("decision", { ...(await authorizeParams()), approve: true, org_ids: ["10"], mode: "ask" }, bob)
    expect(act.status).toBe(403)
    const alice = await jwtFor("alice")
    const { code } = await approveFor(alice, { mode: "ask" })
    expect(((await (await redeem(tokenFields(code))).json()) as { scope: string }).scope).toBe("act")
  })

  it("requires a nonempty organization allowlist", async () => {
    const jwt = await seed()
    const none = await consent("decision", { ...(await authorizeParams()), approve: true }, jwt)
    expect(none.status).toBe(400)
  })

  it("returns access_denied to the client on denial", async () => {
    const jwt = await seed()
    const response = await consent("decision", { ...(await authorizeParams()), approve: false }, jwt)
    const redirect = new URL(((await response.json()) as { redirect: string }).redirect)
    expect(redirect.searchParams.get("error")).toBe("access_denied")
    expect(redirect.searchParams.get("state")).toBe("xyz-state")
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM mcp_oauth_codes").first()).toEqual({ n: 0 })
  })

  it("requires a signed-in session", async () => {
    await seed()
    expect((await consent("request", await authorizeParams(), "invalid")).status).toBe(401)
    expect((await consent("decision", { ...(await authorizeParams()), approve: true, project_id: "p" }, "invalid")).status).toBe(401)
  })
})

describe("untrusted clients", () => {
  it("never redirects to a URI the client document does not list", async () => {
    const jwt = await seed()
    const response = await consent("request", await authorizeParams({ redirect_uri: "https://evil.example/cb" }), jwt)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; redirect?: string }
    expect(body.error).toBe("invalid_request")
    expect(body.redirect).toBeUndefined()
  })

  it("rejects a document that does not name itself, or a non-https client id", async () => {
    const jwt = await seed()
    clientDocument = { ...clientDocument, client_id: "https://chatgpt.com/other.json" }
    expect(((await (await consent("request", await authorizeParams(), jwt)).json()) as { error: string }).error).toBe("invalid_client")
    const plain = await consent("request", await authorizeParams({ client_id: "http://chatgpt.com/oauth/client.json" }), jwt)
    expect(((await plain.json()) as { error: string }).error).toBe("invalid_client")
    // The non-https id was refused before any network fetch.
    expect(fetchSpy.mock.calls.map(([input]) => String(input))).not.toContain("http://chatgpt.com/oauth/client.json")
  })

  it("sends request errors back to a trusted redirect, with state and iss", async () => {
    const jwt = await seed()
    for (const [overrides, error] of [
      [{ code_challenge: undefined }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://elsewhere.example/api/v1/external/mcp" }, "invalid_target"],
      [{ resource: "http://api.aquilla.app/sync/api/v1/external/mcp" }, "invalid_target"],
      [{ resource: "https://api.aquilla.app:8443/sync/api/v1/external/mcp" }, "invalid_target"],
      [{ resource: "https://api.aquilla.app/other/api/v1/external/mcp" }, "invalid_target"],
    ] as const) {
      const response = await consent("request", await authorizeParams(overrides), jwt)
      expect(response.status).toBe(400)
      const redirect = new URL(((await response.json()) as { redirect: string }).redirect)
      expect(redirect.searchParams.get("error")).toBe(error)
      expect(redirect.searchParams.get("state")).toBe("xyz-state")
      expect(redirect.searchParams.get("iss")).toBe(ISSUER)
    }
  })
})


describe("pinned client documents on local stacks (AQU-1641)", () => {
  const EVIL = "https://evil.example/cb"
  const withPins = (pins: object[], local: boolean) => Object.assign(Object.create(oauthEnv) as typeof env, {
    MCP_OAUTH_PINNED_CLIENTS: JSON.stringify(pins),
    WRANGLER_LOCAL: local ? "1" : "0",
  })
  const request = (body: object, jwt: string, e: typeof env) => app.request("/api/v2/mcp-oauth/request", {
    method: "POST", headers: authHeader(jwt), body: JSON.stringify(body),
  }, e)

  it("serves the pinned document instead of fetching the client id", async () => {
    const jwt = await seed()
    const pinned = withPins([{ client_id: CLIENT_ID, client_name: "Pinned ChatGPT", redirect_uris: [REDIRECT] }], true)
    const response = await request(await authorizeParams(), jwt, pinned)
    expect(response.status).toBe(200)
    expect(((await response.json()) as { clientName: string }).clientName).toBe("Pinned ChatGPT")
    expect(fetchSpy.mock.calls.map(([input]) => String(input))).not.toContain(CLIENT_ID)
  })

  it("still validates a pinned document", async () => {
    const jwt = await seed()
    const pinned = withPins([{ client_id: CLIENT_ID, redirect_uris: ["http://evil.example/cb"] }], true)
    const response = await request(await authorizeParams(), jwt, pinned)
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe("invalid_client")
  })

  it("is ignored outside WRANGLER_LOCAL", async () => {
    const jwt = await seed()
    const pinned = withPins([{ client_id: CLIENT_ID, redirect_uris: [EVIL] }], false)
    const response = await request(await authorizeParams({ redirect_uri: EVIL }), jwt, pinned)
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe("invalid_request")
    expect(fetchSpy.mock.calls.map(([input]) => String(input))).toContain(CLIENT_ID)
  })
})

describe("OAuth organization grants across real consumers (AQU-1529)", () => {
  async function multiOrgGrant() {
    const jwt = await seed()
    await env.AQUILLA_PG.prepare(`INSERT INTO organizations (id, name, owner_user_id)
      VALUES (11, 'Beta', 2), (12, 'Excluded', 2)`).run()
    await env.AQUILLA_PG.prepare(`INSERT INTO org_members (org_id, user_id, role_level)
      VALUES (11, 1, 600), (12, 1, 600)`).run()
    await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by, org_id)
      VALUES ('beta', 'Beta project', 2, 11), ('excluded', 'Excluded project', 2, 12)`).run()
    const { code } = await approveFor(jwt, { org_ids: ["10", "11"] })
    const response = await redeem(tokenFields(code))
    expect(response.status).toBe(200)
    const { access_token: token } = await response.json() as { access_token: string }
    return { jwt, token }
  }

  it("passes the minted allowlist through discovery, read and write gates", async () => {
    const { jwt, token } = await multiOrgGrant()
    const cred = (await validateApiCredential(env.AQUILLA_PG, token, undefined, RESOURCE))!
    expect(cred.orgIds).toEqual(["10", "11"])
    expect((await listOrgsForCredential(env.AQUILLA_PG, cred)).map((org) => org.id)).toEqual(["10", "11"])
    expect((await listProjectsForCredential(env.AQUILLA_PG, cred)).map((project) => project.id).sort()).toEqual(["beta", "p"])
    for (const project of ["p", "beta"]) {
      expect((await scopeCredentialToProject(env, cred, project)).ok).toBe(true)
      await expect(assertCredentialScope(env.AQUILLA_PG, cred, project)).resolves.toBeDefined()
    }
    expect((await scopeCredentialToProject(env, cred, "excluded")).ok).toBe(false)
    await expect(assertCredentialScope(env.AQUILLA_PG, cred, "excluded")).rejects.toMatchObject({ code: "scope_denied" })
    const listing = await app.request("/api/v2/credentials", { headers: authHeader(jwt) }, oauthEnv)
    expect(await listing.json()).toMatchObject({ credentials: [{ orgIds: ["10", "11"] }] })
  })

  it("does not authorize organizations joined after consent", async () => {
    const { token } = await multiOrgGrant()
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (13, 'Future', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by, org_id) VALUES ('future', 'Future project', 1, 13)").run()
    const cred = (await validateApiCredential(env.AQUILLA_PG, token, undefined, RESOURCE))!
    expect((await listOrgsForCredential(env.AQUILLA_PG, cred)).map((org) => org.id)).toEqual(["10", "11"])
    await expect(assertCredentialScope(env.AQUILLA_PG, cred, "future")).rejects.toMatchObject({ code: "scope_denied" })
  })

  it("removes lost org access even when a direct project membership remains", async () => {
    const { token } = await multiOrgGrant()
    await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level) VALUES ('beta', 1, 600)").run()
    await env.AQUILLA_PG.prepare("DELETE FROM org_members WHERE org_id = 11 AND user_id = 1").run()
    const cred = (await validateApiCredential(env.AQUILLA_PG, token, undefined, RESOURCE))!
    expect(cred.orgIds).toEqual(["10"])
    expect((await scopeCredentialToProject(env, cred, "beta")).ok).toBe(false)
    await expect(assertCredentialScope(env.AQUILLA_PG, cred, "beta")).rejects.toMatchObject({ code: "scope_denied" })
    expect((await listProjectsForCredential(env.AQUILLA_PG, cred)).map((project) => project.id)).toEqual(["p"])
  })

  // [Pen test] Auth & session mgmt (2026-10-05, OPS-43). The test above covers
  // the approver *leaving* the org. Demotion is the commoner case and was the
  // uncovered one: the re-filter's floor was VIEWER (100) while consent and
  // the mint-time re-check both require MAINTAINER (600), so of the three
  // places the grant floor is applied, the only one that runs after the token
  // exists was the one a demotion could not narrow.
  it("drops an org the approver no longer maintains, not only one they left (OPS-43)", async () => {
    const { token } = await multiOrgGrant()
    await env.AQUILLA_PG.prepare(
      "UPDATE org_members SET role_level = 100 WHERE org_id = 11 AND user_id = 1",
    ).run()
    const cred = (await validateApiCredential(env.AQUILLA_PG, token, undefined, RESOURCE))!
    expect(cred.orgIds).toEqual(["10"])
    expect((await listOrgsForCredential(env.AQUILLA_PG, cred)).map((org) => org.id)).toEqual(["10"])
    expect((await scopeCredentialToProject(env, cred, "beta")).ok).toBe(false)
    await expect(assertCredentialScope(env.AQUILLA_PG, cred, "beta"))
      .rejects.toMatchObject({ code: "scope_denied" })
  })

  it("keeps an org whose owner the approver still is, at any org_members level (OPS-43)", async () => {
    // Org 10 is alice's own; the owner arm must not be narrowed by the floor.
    const { token } = await multiOrgGrant()
    await env.AQUILLA_PG.prepare(
      "UPDATE org_members SET role_level = 100 WHERE org_id = 11 AND user_id = 1",
    ).run()
    const cred = (await validateApiCredential(env.AQUILLA_PG, token, undefined, RESOURCE))!
    expect((await scopeCredentialToProject(env, cred, "p")).ok).toBe(true)
  })

  it("re-filters at the same floor the consent screen and the mint enforce (OPS-43)", () => {
    expect(OAUTH_ORG_ALLOWLIST_FLOOR).toBe(ROLE.MAINTAINER)
  })

  it("does not mint a partially widened grant when one selected org is unauthorized", async () => {
    const jwt = await seed()
    const response = await consent("decision", { ...(await authorizeParams()), approve: true, org_ids: ["10", "999"] }, jwt)
    expect(response.status).toBe(403)
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM mcp_oauth_codes").first()).toEqual({ n: 0 })
  })
})

describe("OAuth audience", () => {
  it("binds an omitted resource to the configured MCP endpoint and rejects replay", async () => {
    const jwt = await seed()
    const { code } = await approveFor(jwt, { resource: undefined })
    const fields = tokenFields(code)
    delete (fields as Partial<typeof fields>).resource
    const response = await redeem(fields)
    expect(response.status).toBe(200)
    const { access_token } = await response.json() as { access_token: string }
    expect(await validateApiCredential(env.AQUILLA_PG, access_token)).toBeNull()
    expect(await validateApiCredential(env.AQUILLA_PG, access_token, undefined, RESOURCE + "/other")).toBeNull()
    expect(await validateApiCredential(env.AQUILLA_PG, access_token, undefined, RESOURCE))
      .toMatchObject({ oauthResource: RESOURCE, mode: "act" })
  })
})
