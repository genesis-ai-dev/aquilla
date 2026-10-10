// Idempotency ledger for the side-effect queue (AQU-1824).
//
// Cloudflare Queues guarantee at-least-once delivery: a consumer can see the
// same message twice even when nothing failed. For a side effect that is
// visible to a user — an email — "twice" is a defect, so every leaf message
// claims its delivery here before performing the work.
//
// Table: side_effect_deliveries (db/postgres/migrations/0158_…sql), keyed by
// the producer-built key from `sideEffectIdempotencyKey`.

/** How much of a provider error is kept on the row for operators. */
const MAX_LAST_ERROR_CHARS = 500

/**
 * Claim a delivery. Returns true when the caller should perform the work.
 *
 * One statement, so two consumers racing on the same key cannot both claim it:
 * the second one's `ON CONFLICT` branch is evaluated against the row the first
 * one wrote. The `WHERE status <> 'sent'` guard is what makes a repeat
 * delivery a no-op — a sent delivery returns no row, so the caller skips.
 *
 * A row in `pending` or `failed` IS re-claimed (attempts is bumped, status is
 * left alone). That is the deliberate direction: treating an in-flight row as
 * "probably already sent" would drop mail every time a worker died mid-send,
 * which is the failure this ticket removes. The residual risk is one duplicate
 * in the window where the provider accepted the message but the `markDelivered`
 * write did not land.
 */
export async function claimDelivery(
  db: AquillaDb,
  idempotencyKey: string,
  kind: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO side_effect_deliveries (idempotency_key, kind, status, attempts)
       VALUES (?, ?, 'pending', 1)
       ON CONFLICT (idempotency_key) DO UPDATE
          SET attempts = side_effect_deliveries.attempts + 1,
              updated_at = now()
        WHERE side_effect_deliveries.status <> 'sent'
       RETURNING idempotency_key`,
    )
    .bind(idempotencyKey, kind)
    .first<{ idempotency_key: string }>()
  return row !== null
}

/** Mark a claimed delivery done. Nothing may perform it again. */
export async function markDelivered(
  db: AquillaDb,
  idempotencyKey: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE side_effect_deliveries
          SET status = 'sent', last_error = NULL, updated_at = now()
        WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey)
    .run()
}

/**
 * Record a failed attempt. The row stays retryable — the queue's own
 * `max_retries` / `dead_letter_queue` policy decides when to stop, and a row
 * left `failed` once the DLQ gives up is the audit trail for mail that never
 * went out.
 *
 * Never flips a row that is already `sent`: a late failure report from a
 * duplicate attempt must not reopen a completed delivery.
 */
export async function markDeliveryFailed(
  db: AquillaDb,
  idempotencyKey: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await db
    .prepare(
      `UPDATE side_effect_deliveries
          SET status = 'failed', last_error = ?, updated_at = now()
        WHERE idempotency_key = ? AND status <> 'sent'`,
    )
    .bind(message.slice(0, MAX_LAST_ERROR_CHARS), idempotencyKey)
    .run()
}
