import { env } from "cloudflare:test"
import { expect, it } from "vitest"
import { createHmac } from "node:crypto"
import app from "../index"
import { seedUser } from "./helpers/db"

it("waits for the workspace lock across live Postgres connections", async () => {
  await seedUser(1, "owner")
  await env.AQUILLA_PG.prepare(`INSERT INTO organizations
    (id, name, owner_user_id) VALUES (1, 'Test', 1)`).run()
  let release!: () => void
  let locked!: () => void
  const ready = new Promise<void>(resolve => { locked = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const holder = env.AQUILLA_PG.transaction!(async tx => {
    await tx.prepare("SELECT id FROM organizations WHERE id = 1 FOR UPDATE").first()
    locked()
    await gate
  })
  await ready
  const body = JSON.stringify({ id: "evt_contended",
    type: "checkout.session.completed", data: { object: {
      metadata: { orgId: "1", kind: "addon", packs: "2" },
    } } })
  const t = Math.floor(Date.now() / 1000)
  const secret = "whsec_fixture"
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")
  const send = () => app.request("http://local/api/v2/billing/webhook", {
    method: "POST", body,
    headers: { "stripe-signature": `t=${t},v1=${sig}` },
  }, { ...env, STRIPE_WEBHOOK_SECRET: secret })
  const deliveries = Promise.all([send(), send()])
  try {
    // Observe both handlers waiting on the real server; no elapsed-time sleep.
    await expect.poll(async () => env.AQUILLA_PG.prepare(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
       AND query LIKE 'SELECT id FROM organizations%'`,
    ).first(), { timeout: 10000 }).toEqual({ n: 2 })
  } finally {
    release()
    await holder
    await deliveries
  }
  const responses = await deliveries
  expect(responses.map(r => r.status)).toEqual([200, 200])
  const bodies = await Promise.all(responses.map(r => r.json() as Promise<{ duplicate?: boolean }>))
  expect(bodies.filter(b => b.duplicate)).toHaveLength(1)
  expect(await env.AQUILLA_PG.prepare(
    "SELECT addon_packs FROM org_billing WHERE org_id = 1",
  ).first()).toEqual({ addon_packs: 2 })
  expect(await env.AQUILLA_PG.prepare(
    "SELECT count(*)::int AS n FROM org_billing_events",
  ).first()).toEqual({ n: 1 })
})
