// The Airtable personal access token (AQU-804): stored the way Monday's OAuth
// token is — AES-GCM encrypted in integration_connections (lib/integrations/
// token-crypto.ts, its own ":airtable-token" key context, the same
// MONDAY_TOKEN_KEY/SECRET_KEY material), never returned by any route.
//
// A personal access token doesn't expire or refresh, so there is no refresh
// path: the one accessor below checks the AQU-1775 environment gate and
// decrypts. Every Airtable call path (routes, push engine, analyze) reads the
// token through getAirtableToken and nothing else.

import type { Env } from "../../types"
import type { IntegrationConnectionRow } from "../monday/types"
import { foreignConnectionError } from "../monday/tokens"
import {
  decryptIntegrationToken,
  encryptIntegrationToken,
  integrationTokenKeyMaterial,
} from "../integrations/token-crypto"

const KEY_CONTEXT = ":airtable-token"

export async function encryptAirtableToken(
  env: Pick<Env, "SECRET_KEY" | "MONDAY_TOKEN_KEY">,
  token: string,
): Promise<string> {
  return encryptIntegrationToken(integrationTokenKeyMaterial(env), KEY_CONTEXT, token)
}

export async function decryptAirtableToken(
  env: Pick<Env, "SECRET_KEY" | "MONDAY_TOKEN_KEY">,
  encoded: string,
): Promise<string> {
  return decryptIntegrationToken(integrationTokenKeyMaterial(env), KEY_CONTEXT, encoded)
}

/**
 * AQU-1775 for Airtable: the connection row was made by another deployment
 * (a production row on dev after the Neon copy). Pushing with it would write
 * dev's numbers into a customer's table. Raised before any decrypt.
 */
export class AirtableForeignConnectionError extends Error {
  constructor(
    readonly connectionEnvironment: string | null,
    readonly runningEnvironment: string,
  ) {
    super(
      `Airtable connection was made on ${connectionEnvironment ?? "an unknown environment"}; refusing to use it from ${runningEnvironment}`,
    )
    this.name = "AirtableForeignConnectionError"
  }
}

/** Null when this worker may use the row — the same rule as Monday's. */
export function airtableForeignConnectionError(
  env: Pick<Env, "ENVIRONMENT" | "WRANGLER_LOCAL">,
  conn: Pick<IntegrationConnectionRow, "environment">,
): AirtableForeignConnectionError | null {
  const refusal = foreignConnectionError(env, conn)
  return refusal
    ? new AirtableForeignConnectionError(refusal.connectionEnvironment, refusal.runningEnvironment)
    : null
}

/** The ONE accessor every Airtable call path uses. */
export async function getAirtableToken(env: Env, conn: IntegrationConnectionRow): Promise<string> {
  const foreign = airtableForeignConnectionError(env, conn)
  if (foreign) throw foreign
  return decryptAirtableToken(env, conn.access_token_enc)
}

/** Airtable said the token is no good (revoked, deleted): ask for a new one. */
export async function markAirtableNeedsNewToken(env: Env, connectionId: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "UPDATE integration_connections SET needs_reauth = TRUE, updated_at = now() WHERE id = ?",
  )
    .bind(connectionId)
    .run()
}
