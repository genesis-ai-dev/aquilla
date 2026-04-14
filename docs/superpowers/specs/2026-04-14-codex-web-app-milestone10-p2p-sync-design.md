# Codex Web App — Milestone 10: P2P Sync with Shareable Links

## Overview

Real-time collaboration via WebRTC. Each file's Y.Doc syncs directly between peers over data channels — no server sees content. Shareable `/join/{token}` deep links, optional PIN protection, peer presence indicator. Signaling uses public `y-webrtc` infrastructure for MVP; a Cloudflare Durable Object migration is planned for a follow-up milestone.

## Sync Stack

- **`y-webrtc`** provider — handles signaling, WebRTC, and Yjs awareness out of the box
- **Public STUN**: `stun:stun.l.google.com:19302`
- **Public signaling**: `y-webrtc` defaults (`wss://y-webrtc-signaling-*.yjs.dev`)
- **Optional TURN**: `openrelay.metered.ca` for symmetric NAT cases

Room naming: each file's Y.Doc joins a room named after the share token, scoped per file: `codex:share:{token}:file:{fileId}`.

## Data Model

### Share Invites

New `ShareInvite` type stored in an IndexedDB `shares` store:

```typescript
export interface ShareInvite {
  token: string                // 8-char URL-safe random
  projectId: string
  pinHash?: string             // SHA-256 hex of PIN, if PIN enabled
  createdAt: string
  createdBy: string
}
```

IndexedDB schema version bumps to 3 to add `shares` store indexed by `projectId`.

### Peer State (ephemeral, via Yjs awareness)

```typescript
interface PeerState {
  peerId: string                // ephemeral, per-session
  username: string              // from project settings
  color: string                 // deterministic from peerId for avatar
  currentFileId?: string        // which file this peer is viewing
}
```

Not persisted; only exists in awareness state while peers are connected.

## Token + PIN

- Token: 8 random URL-safe chars (47-bit entropy), generated via `crypto.getRandomValues`
- PIN: 6 numeric digits (1M combos), entered by owner at share creation
- PIN hash: `SHA-256(pin + token)` — salted so the same PIN across different shares produces different hashes
- PIN sent peer-to-peer during handshake (never to signaling server); hash compared client-side

## Share Creation Flow

1. Owner clicks Share button in toolbar → `SharePanel` dialog
2. Owner clicks "+ Create share link"
3. Dialog asks for optional PIN (checkbox to enable, 6-digit numeric input)
4. App generates token + optional `pinHash`, stores `ShareInvite` in IndexedDB
5. Display generated URL (`/join/{token}`) + PIN (if set) + copy buttons
6. Active peers participating in share shown below

## Join Flow (`/join/{token}`)

1. Recipient visits URL → `JoinPage` component
2. Page checks for local ShareInvite with this token (in case they previously joined). If found and no PIN cached → begin sync immediately.
3. If no local match → attempt to discover peers via the signaling room `codex:share:{token}:bootstrap`
4. Connect to first available peer over WebRTC
5. Send handshake message: `{ type: "join-request", peerId, pinHash? }`
6. Existing peer verifies `pinHash` matches their stored hash (if PIN enabled)
7. On success, existing peer sends bootstrap payload:
   - `{ type: "bootstrap", projectRecord, fileIds: [...] }`
8. Recipient creates local IndexedDB project record, then joins each file's y-webrtc room
9. Each file's Y.Doc syncs normally via y-webrtc; IndexedDB persistence on recipient side captures the synced state
10. Recipient navigates to `/project/{projectId}` — project is now fully present locally
11. Subsequent sessions: recipient's local IDB has the project; they rejoin directly via the same invite link without re-bootstrap

If signaling succeeds but no peer is online:
- Show: "No collaborators online. Ask the owner to open the project."
- Retry automatically every 30 seconds

## Revocation

- **Soft revoke** — delete ShareInvite locally. Already-joined peers retain access because their local IndexedDB already has the data.
- **Revoke all peers (hard)** — delete ShareInvite AND emit an `invalidate-share` broadcast on all active y-webrtc rooms. Any peer receiving this message clears their local copy of the project and disconnects. Cannot fully prevent malicious peers (they can disable the handler), but handles honest-client scenarios.
- **Regenerate PIN** — generate new `pinHash`, update the ShareInvite. New joins need new PIN. Does not kick existing peers unless combined with revoke-all.

## Peer Presence

`PeerPresence` component in Toolbar shows up to 5 stacked avatar circles for connected peers (each with `username`'s initials + deterministic color). Tooltip shows name. Click opens a popover with full peer list.

Presence derived from `y-webrtc` awareness on the currently-active file doc. When active file changes, the awareness entry updates `currentFileId`.

## Bootstrap Payload

For a new joiner to receive the project:

```typescript
interface BootstrapPayload {
  type: "bootstrap"
  projectRecord: ProjectRecord
  // File IDs only — the actual file content syncs via each file's y-webrtc room.
  // Recipient joins all file rooms simultaneously to receive state.
  fileIds: string[]
}
```

Sent over a dedicated "bootstrap" Y.Doc (rooted in `codex:share:{token}:bootstrap`) — small ephemeral doc just to coordinate the handshake and send the projectRecord JSON. Once received, the recipient clears this doc from their end.

## Handshake Protocol (Bootstrap Room)

1. New peer joins the bootstrap room with awareness state `{ peerId, needsBootstrap: true, pinHash? }`
2. Existing peer with `needsBootstrap: false` sees the new peer's awareness
3. Existing peer verifies `pinHash` (if PIN required on their local ShareInvite)
4. On verified match, existing peer writes a bootstrap message into the bootstrap room's Y.Map keyed by the new peer's peerId:
   ```
   bootstrapMap.set(newPeerId, { type: "bootstrap", projectRecord, fileIds })
   ```
5. New peer observes the message, reads it, acknowledges via awareness `{ bootstrapReceived: true }`
6. Both peers clean up their bootstrap map entries
7. New peer joins each file's sync room

## UI

### SharePanel Dialog

Triggered from toolbar Share button. Shows:
- **Existing shares** list (one per share): URL + copy, PIN reveal toggle, Revoke button, "Revoke all peers" button, active peer count
- **"+ Create share link"** button → inline form: "Require PIN?" checkbox → if checked, shows generated 6-digit PIN (auto-generated, with regenerate button)
- After creation, new share appears in the list

### JoinPage

Full-page flow at `/join/{token}`:
- Phase 1: "Connecting to project..." spinner
- Phase 2: PIN prompt (if required) — 6 numeric inputs
- Phase 3: "Syncing project content..." progress indicator (with file count)
- Phase 4: Auto-redirect to `/project/{projectId}`
- Error states: invalid token, no peers online, wrong PIN

### Toolbar

Add `Share2` icon button between Search and Comments. Add `PeerPresence` component showing 1-5 avatar circles to the right of the project name.

## Files Affected

**New:**
- `src/lib/parsers/types.ts` — MODIFY: add `ShareInvite` interface
- `src/lib/store/project-index.ts` — MODIFY: bump DB version to 3, add `shares` store
- `src/lib/sync/share-tokens.ts` — token generation, PIN hashing, CRUD
- `src/lib/sync/share-tokens.test.ts` — TDD
- `src/lib/sync/webrtc-provider.ts` — y-webrtc wrapper
- `src/lib/sync/bootstrap.ts` — handshake logic
- `src/hooks/useSync.ts` — provider lifecycle, peer list
- `src/components/SharePanel.tsx` — share management dialog
- `src/components/JoinPage.tsx` — /join/{token} flow
- `src/components/PeerPresence.tsx` — stacked avatars

**Modified:**
- `src/App.tsx` — add `/join/:token` route
- `src/components/Toolbar.tsx` — Share2 button + PeerPresence
- `src/components/ProjectWorkspace.tsx` — wire useSync, PeerPresence

## Not In Scope

- Swap signaling to Cloudflare Durable Objects (planned for follow-up)
- Granular permissions (read-only, comment-only)
- Time-limited invites
- Collaborative cursors in the TipTap editor
- Kick individual peers
- Server-side state backup
- Encrypted transport (WebRTC DTLS is already encrypted; we're relying on it)
