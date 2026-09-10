# Community checking — feature-flagged WIP (AQU-1249)

Enable **Community checking (WIP)** under **Project settings → Experimental**.
Project leads can create a checking link on that page. The experiment is off
by default and follows the existing device-local flag convention. Turning the
flag off hides creation controls; revoke existing links explicitly.

A link captures selected units in their displayed order. The hierarchy supports
project, file, chapter (when canonical references exist), and individual units.
Future imports never expand an existing link's scope. Links expire after 30 days.
The optional PIN uses the existing scrypt password implementation, a five-failure
lockout, and bounded join attempts. Guests enter a display name; they receive a
checking capability, not a normal account or project membership.

The guest page presents the selected passages, continuous playback of selected
recordings, and feedback. Feedback uses the existing IndexedDB outbox with a
separate guest owner, then the canonical event ingestion and comments projector.
It appears in the project's normal comments view, attributed to the name and
guest identifier. The browser retains the guest credential so closing and
reopening the link can retry queued feedback. A revoked or expired link refuses
pending writes; the page reports that they remain on the device.

## Access boundary

Guest tokens use the `checking` audience. Ordinary project, file, event, audio,
and WebSocket token verifiers reject them. The checking gateway checks the link,
creator's current sharing authority, project lifecycle, selected file/cell IDs,
and selected recording before releasing data. It never returns a normal sync
token. New cell comments go through the existing event writer using a short-lived
internal token: the creator's numeric ID supplies live membership authority,
and the server stamps the guest's distinct name/identifier as the event author.
Guests cannot submit edits, replies, resolutions, validations, or project-wide
comments through this gateway. Revocation applies on every subsequent request;
bytes already downloaded to a browser cannot be recalled.

## Deliberate sample limits

- Viewer links allow listening. Commenter links allow new passage feedback.
- Reviewer links collect review feedback; formal validation is not implemented.
- The sample includes the default text lane and selected `recording` slot.
  Additional language lanes, generated voices, and other tracks need an explicit
  creator picker before they can be shared.
- The picker currently lists source-backed units, up to 2,000 selected per link.
  Target-only units and very large projects need a paged picker.
- Sequential playback downloads each recording and advances when it ends.
  It does not export a stitched chapter file or guarantee gapless playback.
- Guest feedback drafts stay with their selected passage during navigation.
  Submitted feedback survives reloads in the outbox. Unsubmitted drafts are
  in-memory only.
- The sample does not expose existing internal comment threads to guests.
- Shared guest identity is a supplied name, not a verified identity.

Apply `0090_community_checking.sql` before deploying either worker or the UI.
No new Cloudflare binding is required. This WIP is not deployed by this PR.

## Verification

`cross-user-comment.smoke.spec.ts` covers creation through the experimental UI,
a separate guest browser, PIN redemption, R2 playback across two recordings,
feedback submission, owner visibility, and guest reload. Worker tests cover the
capability boundary, out-of-scope rejection, role limits, PIN/expiry/revocation,
and idempotent event projection. RTL covers default-off discovery, hierarchical
selection, viewer controls, and per-passage drafts. The client producer's real
outbox event is also parsed by the gateway schema in a composition test.
