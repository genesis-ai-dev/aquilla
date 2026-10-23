# Claude tool verification matrix

Checked through 2026-10-24, Asia/Singapore.

The original hosted catalog has 40 tools. AQU-2135 adds `upload_artifact`,
bringing the revised catalog to 41. Successful hosted coverage remains 34
original tools. Local regression coverage closes the remaining workflow
boundaries; it does not establish that those fixes run in production.

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
| `list_terms` | PASS | — |
| `patch_settings` | PASS | — |
| `prepare_create_project` | PASS | PASS: declared lanes → forced Ask → approval → actual lane rows (AQU-2136). |
| `prepare_delete_cell` | PASS | — |
| `prepare_draft_cells` | FAIL: job_failed; nothing staged | PASS: declared OAuth tool → service-binding fixture → commit → AI draft readback (AQU-2156). |
| `prepare_hide_cells` | PASS | — |
| `prepare_import` | Not run | PASS: uploaded source → preview → prepare → commit → original sidecar (AQU-2135). |
| `prepare_insert_cell` | PASS | — |
| `prepare_link_media` | Not run | PASS: OAuth base64 audio → native take commit and R2 bytes (AQU-2135). |
| `prepare_replace_project_settings` | PASS | — |
| `prepare_show_cells` | PASS | — |
| `prepare_split_cell` | PASS | — |
| `prepare_translations` | PASS | — |
| `preview_import` | Not run | PASS: actual uploaded text, DOCX and multi-book source (AQU-2135). |
| `read_cell_memory` | PASS | — |
| `read_comments` | PASS | — |
| `read_content` | PASS | — |
| `read_history` | PASS | — |
| `read_quality` | PASS | — |
| `read_term_consistency` | PASS | — |
| `search_project` | PASS | — |
| `search_projects` | PASS | — |
| `transcribe_audio` | Not run | PASS: OAuth scope/role checks and backend request composition (AQU-2155); service-binding transport (AQU-2156). |
| `transcription_status` | FAIL: project-only credential gate | PASS: scoped OAuth status, denials and warm/status request composition (AQU-2155). |
| `upload_artifact` | Not run | PASS: OAuth text/binary upload, bounds, denial and byte preservation (AQU-2135). |
| `wait_for_changeset` | PASS | PASS: pre-creation approval observation and confirm (AQU-2137). |

Hosted `get_changeset` and `wait_for_changeset` pass for existing projects.
Pre-creation reads fail in current production; AQU-2137 fixes that locally.
USFM text export passes. The current binary fallback guidance needs AQU-2135.

Native callback compatibility has 47 passing OAuth/client-metadata tests
under AQU-2154. A real Claude Code OAuth session still needs deployed code.

Do not check the portal’s all-tools-tested acknowledgment until the revised
hosted catalog, denied scope and revocation journeys pass on the submitted URL.
Reviewer credentials belong only in the portal’s private fields.
