// The LangQuest access token of a project link (0185_langquest_links.sql):
// AES-GCM encrypted the way the other integration tokens are
// (lib/integrations/token-crypto.ts), under its own ":langquest-token" key
// context, and never returned by any route.
//
// LangQuest says `review` and `release` tokens belong on a server
// (docs/agent-api.md "Where to keep a token"), which is why the browser never
// holds it after the paste: every LangQuest call goes through routes/langquest.ts.

import type { Env } from "../../types"
import { foreignConnectionError } from "../monday/tokens"
import {
  decryptIntegrationToken,
  encryptIntegrationToken,
  integrationTokenKeyMaterial,
} from "../integrations/token-crypto"

const KEY_CONTEXT = ":langquest-token"

export async function encryptLangQuestToken(
  env: Pick<Env, "SECRET_KEY" | "MONDAY_TOKEN_KEY">,
  token: string,
): Promise<string> {
  return encryptIntegrationToken(integrationTokenKeyMaterial(env), KEY_CONTEXT, token)
}

/**
 * The ONE accessor every LangQuest call path uses. Refuses a row another
 * deployment stored (AQU-1775: production rows copied onto dev) before any
 * decrypt, with the same rule as Monday and Airtable.
 */
export async function getLangQuestToken(
  env: Env,
  link: { token_enc: string; environment: string | null },
): Promise<string> {
  const foreign = foreignConnectionError(env, link)
  if (foreign) throw foreign
  return decryptIntegrationToken(integrationTokenKeyMaterial(env), KEY_CONTEXT, link.token_enc)
}
