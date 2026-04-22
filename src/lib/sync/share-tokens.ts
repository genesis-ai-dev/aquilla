import type { ShareInvite } from "@/lib/parsers/types"
import { getDb } from "@/lib/store/project-index"

// URL-safe alphabet (no ambiguous chars like 0/O, 1/l/I)
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_"
const TOKEN_LENGTH = 8

export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length]
  }
  return out
}

export function generatePin(): string {
  const digits = new Uint8Array(6)
  crypto.getRandomValues(digits)
  let out = ""
  for (let i = 0; i < 6; i++) {
    out += (digits[i] % 10).toString()
  }
  return out
}

export async function hashPin(pin: string, token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(`${pin}:${token}`)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

export async function verifyPin(pin: string, token: string, expectedHash: string): Promise<boolean> {
  const actualHash = await hashPin(pin, token)
  return actualHash === expectedHash
}

export async function createShare(
  projectId: string,
  pin: string | undefined,
  createdBy: string,
  // Optional pre-issued token — callers that create a server-side invite
  // first (see createServerInvite in ./invites.ts) pass that token here so
  // the local ShareInvite and the server's project_invites row agree on
  // the same identifier.
  existingToken?: string
): Promise<ShareInvite> {
  const token = existingToken ?? generateToken()
  const invite: ShareInvite = {
    token,
    projectId,
    pinHash: pin ? await hashPin(pin, token) : undefined,
    createdAt: new Date().toISOString(),
    createdBy: createdBy || "anonymous",
  }
  const db = await getDb()
  await db.put("shares", invite)
  return invite
}

// Save a pre-existing invite (e.g. received by a joiner during bootstrap).
// Used to persist the share locally so useSync can pick it up on the workspace.
export async function saveShare(invite: ShareInvite): Promise<void> {
  const db = await getDb()
  await db.put("shares", invite)
}

export async function listShares(projectId: string): Promise<ShareInvite[]> {
  const db = await getDb()
  const all = await db.getAllFromIndex("shares", "by-project", projectId)
  return (all as ShareInvite[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getShare(token: string): Promise<ShareInvite | undefined> {
  const db = await getDb()
  return db.get("shares", token) as Promise<ShareInvite | undefined>
}

export async function deleteShare(token: string): Promise<void> {
  const db = await getDb()
  await db.delete("shares", token)
}

// Update a share with a new PIN hash (for regeneration)
export async function updateSharePin(token: string, pin: string | undefined): Promise<ShareInvite | undefined> {
  const existing = await getShare(token)
  if (!existing) return undefined
  const updated: ShareInvite = {
    ...existing,
    pinHash: pin ? await hashPin(pin, token) : undefined,
  }
  const db = await getDb()
  await db.put("shares", updated)
  return updated
}
