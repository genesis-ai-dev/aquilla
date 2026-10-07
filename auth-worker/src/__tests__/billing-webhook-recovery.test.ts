import { env } from "cloudflare:test"
import { afterEach, expect, it, vi } from "vitest"
import { createHmac } from "node:crypto"
import app from "../index"
import { seedUser } from "./helpers/db"

const secret = "whsec_recovery_fixture"
const event = {
  id: "evt_recovery",
  type: "customer.subscription.updated",
  data: { object: {
    id: "sub_recovery", customer: "cus_recovery", status: "active",
    metadata: { orgId: "1" },
    items: { data: [{ current_period_start: 1788220800,
      current_period_end: 1790812800 }] },
  } },
}

async function deliver(value: unknown = event) {
  const body = JSON.stringify(value)
  const t = Math.floor(Date.now() / 1000)
  const signature = createHmac("sha256", secret)
    .update(`${t}.${body}`).digest("hex")
  return app.request("http://local/api/v2/billing/webhook", {
    method: "POST", body,
    headers: { "stripe-signature": `t=${t},v1=${signature}` },
  }, { ...env, STRIPE_WEBHOOK_SECRET: secret })
}

async function seed() {
  await seedUser(1, "owner")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Test', 1)",
  ).run()
}

async function countReceipts() {
  return env.AQUILLA_PG.prepare(
    "SELECT count(*)::int AS n FROM org_billing_events",
  ).first<{ n: number }>()
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await env.AQUILLA_PG.exec(
    "DROP TRIGGER IF EXISTS fail_projection ON org_billing",
  )
  await env.AQUILLA_PG.exec("DROP FUNCTION IF EXISTS fail_projection()")
})

it("retries after Postgres rejects application after receipt insertion", async () => {
  await seed()
  await env.AQUILLA_PG.exec(`CREATE FUNCTION fail_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS (SELECT 1 FROM org_billing_events
                 WHERE stripe_event_id = 'evt_recovery') THEN
        RAISE EXCEPTION 'injected failure after receipt';
      END IF;
      RETURN NEW;
    END $$`)
  await env.AQUILLA_PG.exec(`CREATE TRIGGER fail_projection
    BEFORE INSERT OR UPDATE ON org_billing
    FOR EACH ROW EXECUTE FUNCTION fail_projection()`)
  expect((await deliver()).status).toBe(500)
  expect(await env.AQUILLA_PG.prepare(
    "SELECT * FROM org_billing WHERE org_id = 1",
  ).first()).toBeNull()
  await env.AQUILLA_PG.exec("DROP TRIGGER fail_projection ON org_billing")
  const retry = await deliver()
  expect(retry.status).toBe(200)
  expect(await retry.json()).toEqual({ ok: true })
  expect(await env.AQUILLA_PG.prepare(
    "SELECT plan, status, stripe_subscription_id FROM org_billing WHERE org_id = 1",
  ).first()).toEqual({ plan: "field", status: "active",
    stripe_subscription_id: "sub_recovery" })
  expect(await countReceipts()).toEqual({ n: 1 })
})

function addon(id = "evt_addon", packs = "2") {
  return { id, type: "checkout.session.completed",
    data: { object: { metadata: { orgId: "1", kind: "addon", packs } } } }
}

it("deduplicates concurrent signed deliveries and preserves distinct add-ons", async () => {
  await seed()
  const responses = await Promise.all(Array.from({ length: 6 }, () => deliver(addon())))
  expect(responses.map(r => r.status)).toEqual(Array(6).fill(200))
  const bodies = await Promise.all(responses.map(r => r.json() as Promise<{ duplicate?: boolean }>))
  expect(bodies.filter(b => !b.duplicate)).toHaveLength(1)
  expect(bodies.filter(b => b.duplicate)).toHaveLength(5)
  expect(await countReceipts()).toEqual({ n: 1 })
  expect(await (await deliver(addon())).json()).toEqual({ ok: true, duplicate: true })
  const distinct = await Promise.all([deliver(addon("evt_a", "3")),
    deliver(addon("evt_b", "4"))])
  expect(distinct.map(r => r.status)).toEqual([200, 200])
  expect(await env.AQUILLA_PG.prepare(
    "SELECT addon_packs FROM org_billing WHERE org_id = 1",
  ).first()).toEqual({ addon_packs: 9 })
  expect(await countReceipts()).toEqual({ n: 3 })
})

it.each(["org_billing_events", "org_billing"])(
  "fails closed when %s is unavailable and recovers after repair", async (table) => {
    await seed()
    await env.AQUILLA_PG.exec(`ALTER TABLE ${table} RENAME TO recovery_hidden`)
    try {
      expect((await deliver()).status).toBe(500)
    } finally {
      await env.AQUILLA_PG.exec(`ALTER TABLE recovery_hidden RENAME TO ${table}`)
    }
    expect(await countReceipts()).toEqual({ n: 0 })
    expect(await (await deliver()).json()).toEqual({ ok: true })
  },
)

it("does not acknowledge a database lookup failure as an unknown subscription", async () => {
  await seed()
  await env.AQUILLA_PG.exec("ALTER TABLE org_billing RENAME TO recovery_hidden")
  try {
    const invoice = { id: "evt_invoice", type: "invoice.paid",
      data: { object: { subscription: "sub_recovery" } } }
    expect((await deliver(invoice)).status).toBe(500)
  } finally {
    await env.AQUILLA_PG.exec("ALTER TABLE recovery_hidden RENAME TO org_billing")
  }
  expect(await countReceipts()).toEqual({ n: 0 })
})

it("does not misclassify an unrelated unique constraint failure as a duplicate", async () => {
  await seed()
  await env.AQUILLA_PG.prepare(`INSERT INTO org_billing
    (org_id, stripe_customer_id) VALUES (2, 'cus_recovery')`).run()
  expect((await deliver()).status).toBe(500)
  expect(await countReceipts()).toEqual({ n: 0 })
  await env.AQUILLA_PG.prepare("DELETE FROM org_billing WHERE org_id = 2").run()
  expect(await (await deliver()).json()).toEqual({ ok: true })
})

it("rejects missing event IDs before applying non-idempotent add-ons", async () => {
  await seed()
  for (const id of [undefined, "", " "]) {
    expect((await deliver({ ...addon(), id })).status).toBe(400)
  }
  expect(await countReceipts()).toEqual({ n: 0 })
  expect(await env.AQUILLA_PG.prepare("SELECT * FROM org_billing").first()).toBeNull()
})

it("preserves signature enforcement with no database effects", async () => {
  await seed()
  for (const signature of ["", "t=1,v1=invalid"]) {
    const response = await app.request("http://local/api/v2/billing/webhook", {
      method: "POST", body: JSON.stringify(event),
      headers: { "stripe-signature": signature },
    }, { ...env, STRIPE_WEBHOOK_SECRET: secret, WRANGLER_LOCAL: "1" })
    expect(response.status).toBe(400)
  }
  expect(await countReceipts()).toEqual({ n: 0 })
})

it("preserves legacy cancellation, hard caps, and unrelated covered access on replay", async () => {
  await seed()
  await env.AQUILLA_PG.prepare(`INSERT INTO org_billing
    (org_id, plan, status, hard_cap_words, complimentary_words)
    VALUES (1, 'field', 'active', 90000, 100),
           (2, 'enterprise', 'active', 70000, 300)`).run()
  const covered = await env.AQUILLA_PG.prepare(
    "SELECT * FROM org_billing WHERE org_id = 2",
  ).first()
  expect((await deliver()).status).toBe(200)
  const canceled = { ...event, id: "evt_cancel",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_recovery", customer: "cus_recovery" } } }
  expect((await deliver(canceled)).status).toBe(200)
  expect(await (await deliver(canceled)).json()).toEqual({ ok: true, duplicate: true })
  expect(await env.AQUILLA_PG.prepare(`SELECT plan, status, hard_cap_words,
    complimentary_words FROM org_billing WHERE org_id = 1`).first())
    .toEqual({ plan: "none", status: "canceled", hard_cap_words: 90000,
      complimentary_words: 100 })
  expect(await env.AQUILLA_PG.prepare(
    "SELECT * FROM org_billing WHERE org_id = 2",
  ).first()).toEqual(covered)
})

it("rolls back receipt and application when a deferred constraint rejects commit", async () => {
  await seed()
  await env.AQUILLA_PG.exec("CREATE TABLE recovery_commit_keys (id TEXT PRIMARY KEY)")
  await env.AQUILLA_PG.exec(`ALTER TABLE org_billing_events
    ADD CONSTRAINT recovery_commit_failure FOREIGN KEY (stripe_event_id)
    REFERENCES recovery_commit_keys(id) DEFERRABLE INITIALLY DEFERRED`)
  try {
    expect((await deliver()).status).toBe(500)
    expect(await countReceipts()).toEqual({ n: 0 })
    expect(await env.AQUILLA_PG.prepare("SELECT * FROM org_billing").first()).toBeNull()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO recovery_commit_keys VALUES ('evt_recovery')",
    ).run()
    expect(await (await deliver()).json()).toEqual({ ok: true })
    expect(await countReceipts()).toEqual({ n: 1 })
    expect(await env.AQUILLA_PG.prepare(
      "SELECT stripe_subscription_id FROM org_billing",
    ).first()).toEqual({ stripe_subscription_id: "sub_recovery" })
  } finally {
    await env.AQUILLA_PG.exec(
      "ALTER TABLE org_billing_events DROP CONSTRAINT recovery_commit_failure",
    )
    await env.AQUILLA_PG.exec("DROP TABLE recovery_commit_keys")
  }
})

it.each(["checkout", "invoice_legacy", "invoice_parent"])(
  "recovers %s after a Stripe read failure without poisoning deduplication", async kind => {
    await seed()
    expect((await deliver()).status).toBe(200)
    const object = kind === "checkout"
      ? { subscription: "sub_recovery", metadata: { orgId: "1", kind: "field" } }
      : kind === "invoice_legacy"
        ? { subscription: "sub_recovery" }
        : { parent: { subscription_details: { subscription: "sub_recovery" } } }
    const value = { id: "evt_fetch", type: kind === "checkout"
      ? "checkout.session.completed" : "invoice.paid", data: { object } }
    const send = async () => {
      const body = JSON.stringify(value)
      const t = Math.floor(Date.now() / 1000)
      const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")
      return app.request("http://local/api/v2/billing/webhook", {
        method: "POST", body, headers: { "stripe-signature": `t=${t},v1=${sig}` },
      }, { ...env, STRIPE_WEBHOOK_SECRET: secret, STRIPE_SECRET_KEY: "sk_test_fixture" })
    }
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(
      { error: { message: "injected Stripe failure" } }, { status: 503 },
    )).mockImplementation(async () => Response.json(event.data.object))
    vi.stubGlobal("fetch", fetch)
    expect((await send()).status).toBe(500)
    expect(await countReceipts()).toEqual({ n: 1 })
    expect(await (await send()).json()).toEqual({ ok: true })
    expect(await (await send()).json()).toEqual({ ok: true, duplicate: true })
    expect(await countReceipts()).toEqual({ n: 2 })
    expect(await env.AQUILLA_PG.prepare(
      "SELECT plan, stripe_subscription_id FROM org_billing WHERE org_id = 1",
    ).first()).toEqual({ plan: "field", stripe_subscription_id: "sub_recovery" })
  },
)
