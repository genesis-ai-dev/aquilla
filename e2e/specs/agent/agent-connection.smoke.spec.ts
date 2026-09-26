import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { AgentConnectionPage } from "../../helpers/page-objects/AgentConnectionPage"
const auth = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
const sync = `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

test("browser consent delivers a project credential to the agent; revocation blocks API use", async ({ alice }) => {
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
