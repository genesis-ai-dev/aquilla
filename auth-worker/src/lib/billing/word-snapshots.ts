// Word snapshots for many orgs in four queries: billing rows, usage sums,
// override blobs and lane counts. The admin billing list used to call
// readWordSnapshot once per org, one after another — about six round-trips an
// org, which timed out the tab once the platform had a few hundred orgs.
//
// The arithmetic is buildWordSnapshot, shared with readWordSnapshot, so a row
// here always matches what the per-org read answers for the same org.

import {
  type OrgBillingRow,
  type OrgWordSnapshot,
  type SnapshotCatalog,
  buildWordSnapshot,
  countTargetLanesByOrg,
  emptyBillingRow,
  normalizeBillingRow,
  parseBillingOverrides,
  periodStartDate,
  readWordSnapshot,
  trailingYearStart,
} from "./words"

export async function readWordSnapshots(
  db: AquillaDb,
  orgIds: readonly number[],
  catalog?: SnapshotCatalog,
): Promise<Map<number, OrgWordSnapshot>> {
  const ids = [...new Set(orgIds)].filter((id) => Number.isInteger(id) && id > 0)
  const out = new Map<number, OrgWordSnapshot>()
  if (ids.length === 0) return out
  try {
    const placeholders = ids.map(() => "?").join(", ")
    const { results: billingRows } = await db
      .prepare(
        `SELECT org_id, stripe_customer_id, stripe_subscription_id, plan, status,
                current_period_start::text, current_period_end::text,
                addon_packs, complimentary_words, hard_cap_words
           FROM org_billing WHERE org_id IN (${placeholders})`,
      )
      .bind(...ids)
      .all<OrgBillingRow>()
    const billing = new Map<number, OrgBillingRow>()
    for (const row of billingRows ?? []) billing.set(Number(row.org_id), normalizeBillingRow(row))
    for (const id of ids) if (!billing.has(id)) billing.set(id, emptyBillingRow(id))

    // Each org's billing period starts on its own day, so the period start
    // travels with the org id; the trailing-year start is the same for all.
    const yearStart = trailingYearStart()
    const values = ids.map(() => "(?::int, ?::date)").join(", ")
    const [usage, settings, lanes] = await Promise.all([
      db
        .prepare(
          `SELECT s.org_id,
                  COALESCE(SUM(u.words) FILTER (WHERE u.date_utc >= s.since), 0) AS period_words,
                  COALESCE(SUM(u.words) FILTER (WHERE u.date_utc >= ?::date), 0) AS year_words
             FROM (VALUES ${values}) AS s(org_id, since)
             JOIN org_word_usage_daily u
               ON u.org_id = s.org_id AND u.date_utc >= LEAST(s.since, ?::date)
            GROUP BY s.org_id`,
        )
        .bind(yearStart, ...ids.flatMap((id) => [id, periodStartDate(billing.get(id)!)]), yearStart)
        .all<{ org_id: number; period_words: number | string; year_words: number | string }>(),
      db
        .prepare(`SELECT org_id, settings FROM org_settings WHERE org_id IN (${placeholders})`)
        .bind(...ids)
        .all<{ org_id: number; settings: string }>(),
      countTargetLanesByOrg(db, ids),
    ])
    const words = new Map<number, { period: number; year: number }>()
    for (const row of usage.results ?? []) {
      words.set(Number(row.org_id), { period: Number(row.period_words) || 0, year: Number(row.year_words) || 0 })
    }
    const blobs = new Map<number, string>()
    for (const row of settings.results ?? []) blobs.set(Number(row.org_id), row.settings)

    for (const id of ids) {
      out.set(
        id,
        buildWordSnapshot(
          {
            billing: billing.get(id)!,
            wordsUsed: words.get(id)?.period ?? 0,
            trailingYearWords: words.get(id)?.year ?? 0,
            overrides: parseBillingOverrides(blobs.get(id)),
            autoLaneCount: lanes.byOrg.get(id) ?? 0,
          },
          catalog,
        ),
      )
    }
    return out
  } catch (err) {
    // A schema the batch cannot read (a table or column not migrated yet):
    // the per-org read degrades field by field, so fall back to it.
    console.warn("[billing] batched word snapshots failed; reading per org", err)
    for (const id of ids) out.set(id, await readWordSnapshot(db, id, catalog))
    return out
  }
}
