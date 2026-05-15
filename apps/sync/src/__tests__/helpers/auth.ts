// Shared JWT test helper — avoids duplicating makeToken() across test files.

import { sign } from 'hono/jwt'
import type { SyncTokenClaims } from '../../auth'

export async function makeTestToken(
  secret: string,
  overrides: Partial<SyncTokenClaims> = {},
): Promise<string> {
  const claims: SyncTokenClaims = {
    userId: 1,
    username: 'alice',
    projectId: 'p1',
    fileId: 'f1',
    role: 400,
    aud: 'sync',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  }
  return await sign(claims as unknown as Record<string, unknown>, secret, 'HS256')
}
