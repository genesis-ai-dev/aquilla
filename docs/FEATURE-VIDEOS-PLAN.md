# Feature Videos — Walkthrough Plan

Every one of the 688 features in `FEATURE-STORIES.csv` is assigned to one of the **40 walkthrough videos** below (its `VideoPath`). Each video is a doc-mode Showcase take (programmatic cursor + zoom + captions/chapters); each feature it covers gets a `VideoTimestamp` chapter offset once the take is recorded.

Record with the harness (see `.claude/skills/record-docs-video/`):
```sh
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev \
  npm run record -- -g "<take title>"
npm run record:assemble -- --slug <persona>__<slug>
```

| # | Walkthrough | Area | Persona | Features | VideoPath | Status |
| --: | --- | --- | --- | --: | --- | --- |
| 1 | First-run onboarding wizard | Onboarding & Product Tour | New org owner | 42 | `https://docs.aquilla.app/media/onboarding-first-run/onboarding-first-run.mp4` | ✅ recorded |
| 2 | Create an org & change its settings | Orgs & Org Switcher | Org owner / admin | 29 | `https://docs.aquilla.app/media/org-setup/org-setup-create-and-settings.mp4` | ✅ recorded |
| 3 | Invite & manage team members | Teams, Members & Permissions | Org admin / project lead | 29 | `https://docs.aquilla.app/media/teams-invite-members/teams-invite-members.mp4` | ✅ recorded |
| 4 | Read a project's overview & progress | Project Overview | Project manager / owner | 37 | `https://docs.aquilla.app/media/overview-read-progress/overview-read-progress.mp4` | ✅ recorded |
| 5 | Translate a cell in the editor | Editor Core | Translator | 55 | `https://docs.aquilla.app/media/editor-translate-cell/editor-translate-cell.mp4` | ✅ recorded |
| 6 | Import USFM / Paratext source | Import | Project lead | 38 | `https://docs.aquilla.app/media/import-usfm-paratext/import-usfm-paratext.mp4` | ✅ recorded |
| 7 | Export to USFM & DOCX | Export | Any member | 35 | `https://docs.aquilla.app/media/export-usfm-docx/export-usfm-docx.mp4` | ✅ recorded |
| 8 | Find & replace across the project | Search & Replace | Translator / reviewer | 27 | `https://docs.aquilla.app/media/search-find-replace/search-find-replace.mp4` | ✅ recorded |
| 9 | Run checks & fix flagged cells | Rules & Checks | Reviewer / translator | 44 | `https://docs.aquilla.app/media/rules-run-checks/rules-run-checks.mp4` | ✅ recorded |
| 10 | Comment, reply & resolve | Comments | Any collaborator | 33 | `https://docs.aquilla.app/media/comments-discuss/comments-discuss.mp4` | ✅ recorded |
| 11 | Confirm & manage terminology | Terminology | Translator / reviewer | 32 | `https://docs.aquilla.app/media/terminology-confirm-terms/terminology-confirm-terms.mp4` | ✅ recorded |
| 12 | Use & curate Living Memory | Living Memory | Translator / project lead | 24 | `https://docs.aquilla.app/media/living-memory/living-memory.mp4` | ✅ recorded |
| 13 | Voices, TTS & playback | Audio / Voice / Video | Translator | 48 | `https://docs.aquilla.app/media/audio-voice-tts/audio-voice-tts.mp4` | ✅ recorded |
| 14 | Auto-draft a cell with AI | AI Completion | Translator | 27 | `https://docs.aquilla.app/media/ai-autodraft-cell/ai-autodraft-cell.mp4` | ✅ recorded |
| 15 | Org settings & access policy | Settings & Preferences | Org admin / owner | 2 | `https://docs.aquilla.app/media/settings-org/settings-org.mp4` | ✅ recorded |
| 16 | Share a project via link & invites | Sharing & Invites | Project lead / owner | 30 | `https://docs.aquilla.app/media/sharing-invite-link/sharing-invite-link.mp4` | ✅ recorded |
| 17 | Collaborate in real time (presence & locks) | Sync & Collaboration | Any collaborator | 35 | `https://docs.aquilla.app/media/collab-realtime/collab-realtime.mp4` | ✅ recorded |
| 18 | Platform admin & debug tools | Admin | Platform admin / developer | 20 | `https://docs.aquilla.app/media/admin-debug-tools/admin-debug-tools.mp4` | ✅ recorded |

**Total: 18 videos covering 688 features.** Org-setup take partially recorded (`docs/walkthroughs/org-setup/` — create + settings shown).
