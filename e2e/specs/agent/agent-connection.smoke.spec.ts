import { createHash } from "node:crypto"
import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { AgentConnectionPage } from "../../helpers/page-objects/AgentConnectionPage"
const auth = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
const sync = `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

test("browser consent delivers a project credential to the agent; revocation blocks API use", async ({ alice }, testInfo) => {
  // Auth worker + consent SPA + sync worker: cold route hydration watchdog.
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: "Agent connection" })
  const started = await fetch(`${auth}/api/v2/agent-connect/device_authorization`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "aquilla-agent", agent_name: "E2E agent" }),
  })
  expect(started.status).toBe(200)
  const grant = await started.json() as { device_code: string; user_code: string; verification_uri_complete: string }
  const consent = new AgentConnectionPage(alice)
  await consent.review(grant.verification_uri_complete)
  await expect(alice.getByRole("button", { name: "Authorize agent", exact: true })).toBeDisabled()
  await consent.chooseProject(seeded.projectName)
  await expect(alice.getByRole("combobox", { name: "Project" })).toContainText(seeded.projectName)
  await alice.screenshot({ path: testInfo.outputPath("aqu-1205-consent.png"), fullPage: true })
  await consent.authorize(grant.user_code)
  const tokenResponse = await fetch(`${auth}/api/v2/agent-connect/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "aquilla-agent", grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: grant.device_code }),
  })
  expect(tokenResponse.status).toBe(200)
  const credential = await tokenResponse.json() as { access_token: string; credential_id: string; project_id: string }
  expect(credential.project_id).toBe(seeded.projectId)
  const headers = { Authorization: `Bearer ${credential.access_token}` }
  expect((await fetch(`${sync}/api/v1/external/me`, { headers })).status).toBe(200)
  const revoked = await fetch(`${auth}/api/v2/credentials/${credential.credential_id}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${jwt}` },
  })
  expect(revoked.status).toBe(200)
  expect((await fetch(`${sync}/api/v1/external/me`, { headers })).status).toBe(401)
})


test("OAuth browser consent grants Act to selected current organizations only (AQU-1529)", async ({ alice }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const authHeaders = { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }
  async function createOrganization(name: string) {
    const response = await fetch(`${auth}/api/v2/orgs`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ name }),
    })
    expect(response.status).toBe(200)
    return await response.json() as { id: number; name: string }
  }
  const included = await createOrganization("OAuth included")
  const excluded = await createOrganization("OAuth excluded")
  const verifier = "aquilla-browser-consent-verifier-" + "v".repeat(32)
  const callback = "https://chatgpt.com/connector_platform_oauth_redirect"
  const params = new URLSearchParams({
    response_type: "code", client_id: "https://chatgpt.com/oauth/client.json",
    redirect_uri: callback, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", state: "browser-org-snapshot", scope: "ask",
    resource: `${sync}/api/v1/external/mcp`,
  })
  // Capture the host callback without navigating to a real ChatGPT session.
  await alice.route(`${callback}**`, route => route.fulfill({ body: "OAuth callback received" }))
  const consent = new AgentConnectionPage(alice)
  await consent.reviewOAuth(`/oauth/consent?${params}`)
  await consent.chooseAllCurrentOrganizations()
  await consent.excludeOrganization(excluded.name)
  await consent.allowOAuth()
  await expect(alice).toHaveURL(/connector_platform_oauth_redirect.*code=/, { timeout: 30_000 })
  const redirect = new URL(alice.url())
  expect(redirect.searchParams.get("state")).toBe("browser-org-snapshot")
  const tokenResponse = await fetch(`${auth}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: redirect.searchParams.get("code")!,
      code_verifier: verifier, client_id: params.get("client_id")!, redirect_uri: callback,
    }),
  })
  expect(tokenResponse.status).toBe(200)
  const credential = await tokenResponse.json() as { access_token: string; scope: string }
  expect(credential.scope).toBe("act")
  const headers = { Authorization: `Bearer ${credential.access_token}` }
  const future = await createOrganization("OAuth future membership")
  async function callMcp(name: string) {
    const response = await fetch(`${sync}/api/v1/external/mcp`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { content: { text: string }[]; isError?: boolean } }
    expect(body.result.isError).not.toBe(true)
    return JSON.parse(body.result.content[0].text)
  }
  const body = await callMcp("list_orgs") as { orgs: { id: string }[] }
  expect(body.orgs.map(org => String(org.id))).toContain(String(included.id))
  expect(body.orgs.map(org => String(org.id))).not.toContain(String(excluded.id))
  expect(body.orgs.map(org => String(org.id))).not.toContain(String(future.id))
  expect(await callMcp("get_identity_and_scope"))
    .toMatchObject({ mode: "act", orgIds: expect.arrayContaining([String(included.id)]) })
  // OAuth resource scope is separate from the user's live permission ceiling.
  expect((await fetch(`${sync}/api/v1/external/me`, { headers })).status).toBe(401)
})
