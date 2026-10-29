# Claude tool verification matrix

Checked through 2026-10-29, America/Edmonton.

The original hosted catalog has 40 tools. AQU-2135 adds `upload_artifact`;
the later `list_style_rules` brings the live catalog to 42 tools. Claude's
connector settings show 25 read-only and 17 write/delete entries.
Successful hosted coverage now reaches all 42 tools. This counts successful
tool paths, not every provider or optional workflow. The Omnilingual provider
comparison below still fails; Whisper succeeds on the same stored take.

All six backend fix PRs are merged. Production's version document reports
`6b81e477e8b8bd04fb64ad22172b57321155cc6d` on
`release/2026/10/29-01`. That commit contains all six merges. The sync
worker's public health check reports Postgres and R2 healthy.

The first post-deployment attempt uses a different Aquilla grant that excludes
PluginReviewer's organization `46486`. `get_capabilities` and
`get_identity_and_scope` pass. `transcription_status` and
`prepare_draft_cells` both return `scope_denied` at the organization boundary.
These denials establish excluded-scope rejection, not provider recovery.
The user requests reconnection as PluginReviewer before further fixture tests.

Model and transcription service fixtures use controlled responses. They
prove authorization, request composition, staging, persistence and provenance,
not live provider availability. Hosted AI tests must run after deployment.

| Tool | Hosted Claude | Additional local evidence |
| --- | --- | --- |
| `confirm_changeset` | PASS | — |
| `discard_changeset` | PASS | — |
| `export_file` | PASS | PASS: text export and credential-aware binary/size fallback (AQU-2135). |
| `find_similar_cells` | PASS | — |
| `get_capabilities` | PASS | — |
| `get_changeset` | PASS | PASS: pre-creation get/wait with credential, org and live-role denials (AQU-2137). |
| `get_identity_and_scope` | PASS | — |
| `get_project` | PASS | — |
| `get_project_settings` | PASS | — |
| `get_prompt_preview` | PASS | — |
| `get_skill` | PASS | — |
| `list_changesets` | PASS | — |
| `list_memory` | PASS | — |
| `list_orgs` | PASS | — |
| `list_projects` | PASS | — |
| `list_style_rules` | PASS: empty rules | Newly discovered read-only tool. |
| `list_terms` | PASS | — |
| `patch_settings` | PASS | — |
| `prepare_create_project` | PASS | PASS: declared lanes → forced Ask → approval → actual lane rows (AQU-2136). |
| `prepare_delete_cell` | PASS | — |
| `prepare_draft_cells` | PASS: staged, confirmed and read back with AI provenance | PASS: declared OAuth tool → service-binding fixture → commit → AI draft readback (AQU-2156). |
| `prepare_hide_cells` | PASS | — |
| `prepare_import` | PASS: synthetic new file committed and read back | PASS: uploaded source → preview → prepare → commit → original sidecar (AQU-2135). |
| `prepare_insert_cell` | PASS | — |
| `prepare_link_media` | PASS: target-lane take staged, confirmed and verified in history | PASS: OAuth base64 audio → native take commit and R2 bytes (AQU-2135). |
| `prepare_replace_project_settings` | PASS | — |
| `prepare_show_cells` | PASS | — |
| `prepare_split_cell` | PASS | — |
| `prepare_translations` | PASS | — |
| `preview_import` | PASS: USFM preview, two source cells | PASS: actual uploaded text, DOCX and multi-book source (AQU-2135). |
| `read_cell_memory` | PASS | — |
| `read_comments` | PASS | — |
| `read_content` | PASS | — |
| `read_history` | PASS | — |
| `read_quality` | PASS | — |
| `read_term_consistency` | PASS | — |
| `search_project` | PASS | — |
| `search_projects` | PASS | — |
| `transcribe_audio` | PASS: stored Ogg take through Whisper; Omnilingual comparison fails | PASS: OAuth scope/role checks and backend request composition (AQU-2155); service-binding transport (AQU-2156). |
| `transcription_status` | PASS: cold status with organization-scoped OAuth | PASS: scoped OAuth status, denials and warm/status request composition (AQU-2155). |
| `upload_artifact` | PASS: exact 94-byte source upload and matching SHA-256 | PASS: OAuth text/binary upload, bounds, denial and byte preservation (AQU-2135). |
| `wait_for_changeset` | PASS | PASS: pre-creation approval observation and confirm (AQU-2137). |

Hosted `get_changeset` and `wait_for_changeset` pass for existing projects.
Pre-creation reads failed before deployment; the deployed AQU-2137 fix needs
its hosted regression check. USFM text export passes. The deployed binary
fallback guidance also needs a hosted regression check.

Native callback compatibility has 47 passing OAuth/client-metadata tests
under AQU-2154. A real Claude Code OAuth session still needs authenticated verification.

The portal’s Self-tested acknowledgment is checked after every tool returns
a successful hosted result. It asserts custom-connector testing, not every
provider or optional journey. Production token-replay revocation and the
pre-creation regression remain separately unverified in this continuation.
Reviewer credentials belong only in the portal’s private fields.

## Post-reconnection receipts

The new grant confirms only organization `46486`. Draft changeset
`01a18932-b731-7378-9831-fa6fd193ad65` commits event
`01a18932-d6e3-7354-9014-1f6dac92660e`. Readback returns the MAT 1:2 target
“Revisamos juntos esta traducción de prueba.” at sequence 16,
`aiDrafted: true`, `validated: false`, with model and provider provenance.

Source artifact `01a18933-c1d9-77b9-819a-f65319e61119` contains 94 bytes.
Import changeset `01a18934-00fb-73b2-9ef6-1df03dd70674` commits five events
with no stale cells. New file `01a18934-0329-7281-bfdc-bccb4c3d0d46`
contains the synthetic header and MRK 1:1 source, verified by readback.
The existing MAT file has no further changes after sequence 16.

## Binary fixture checks

A 13,550-byte WAV supplied to Claude decodes correctly in its code environment,
but its model-generated upload argument changes to 13,553 bytes. The returned
checksum exposes the mismatch. That artifact is deliberately left unlinked:
`01a1893b-930f-768f-8c46-2ab1b92f8cd4`. No deletion is requested.

A genuine compact WebM fixture returns `validation_failed`, listing the
supported MIME types. No artifact ID is returned. This is explicit format
validation, not a successful media-linking or transcription test. A new
515-byte Ogg fixture passes local and server byte/hash checks. Its artifact is
`01a1893f-385e-7fe0-88e5-63b198a0f952`, with SHA-256
`107e87f1182f9547de1d4c54c7076569ff162845579bd4b6bf050a317bbcf4a9`.
An attempted source-lane link is explicitly rejected because LinkMedia requires
a target lane. No changeset is staged for that rejected request.

The corrected target-lane link stages changeset
`01a18940-98e0-799f-9356-17d519fe70c5`. Confirmation applies two events
with zero stale cells at `2026-10-29T20:01:29.046Z`. The receipt names
MRK 1:1, target lane `f9251aa1`, and slot `recording`. History confirms
`cell.audio.attach` and `cell.audio.select` at sequences 22 and 23.
This English QA recording is not a Spanish translation or human validation.

`transcription_status` reports `omni-ctc` ready. The single selected-take
call returns `job_failed`: "transcription failed: Transcription provider
failed". No transcript, timings or credit count returns. The underlying
provider response and billing ledger still need investigation; no provider
recovery or zero charge is claimed.

A controlled call on the same take with `model: whisper` succeeds:
`text: "Hello."`, one word from 0 to 0.36000001430511475 seconds,
`timingsApproximate: false`, and `creditsCharged: 0.001263`.
The raw hosted tool response confirms these fields. No transcript is saved.
The comparison establishes a successful transcription tool path while keeping
the Omnilingual provider failure visible. No blind retry occurs.
