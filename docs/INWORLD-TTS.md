# Inworld TTS 2 Flash (AQU-1189)

Aquilla's default cloud TTS / zero-shot clone engine is **Inworld TTS 2**
(`inworld-tts-2`). New voices default to Highest quality; Standard selects
Flash (`inworld-tts-2-flash`).

## Where to put the API key

The browser never holds this secret. Only **sync-worker** calls Inworld.

1. Create a **read-write** API key in the [Inworld Portal](https://platform.inworld.ai/)
   (`inworld workspace add-key`, or Portal → API Keys). Instant Voice Cloning
   and Voice Design both need write access on `voices`. A read-only key fails
   clone, design, and publish alike — you do not need a second permission
   beyond the read-write key already required for cloning.
2. Copy the key **as-is** (do not prefix `Basic ` — the worker adds that).

### Local `pnpm dev`

Put it in `sync-worker/.dev.vars` (gitignored). Copy from `.dev.vars.example`:

```
INWORLD_API_KEY="<paste portal key>"
# Optional overrides:
# INWORLD_API_BASE="https://api.inworld.ai"
# INWORLD_TTS_MODEL="inworld-tts-2-flash"
# INWORLD_DEFAULT_VOICE="Dennis"
```

Restart `pnpm dev` after editing `.dev.vars`. Wrangler loads that file into the
local sync-worker; a missing key returns `503 TTS not configured`.

### Deployed environments

Cloudflare Worker **secret** on the sync-worker (not a git-committed `[vars]`):

```bash
cd sync-worker
# development (dev.aquilla.app)
npx wrangler secret put INWORLD_API_KEY --env development

# production (aquilla.app)
npx wrangler secret put INWORLD_API_KEY --env production
```

`config/cloudflare-deployments.json` lists `INWORLD_API_KEY` as a required
**production** secret. Put the same secret on `--env development` before
hosted TTS will work on `dev.aquilla.app`. Optional model/endpoint overrides
may be set as Worker vars (`INWORLD_API_BASE`, `INWORLD_TTS_MODEL`,
`INWORLD_DEFAULT_VOICE`); they default to the values above. The put commands
are also documented in `sync-worker/wrangler.toml`.

Do **not** put the key in `VITE_*`, the SPA, or auth-worker.

## API used by sync-worker

| Purpose | Method | Path |
| --- | --- | --- |
| Synthesize | `POST` | `https://api.inworld.ai/tts/v1/voice` |
| Instant clone | `POST` | `https://api.inworld.ai/voices/v1/voices:clone` |
| Voice design | `POST` | `https://api.inworld.ai/voices/v1/voices:design` |
| Publish designed voice | `POST` | `https://api.inworld.ai/voices/v1/voices/{voiceId}:publish` |
| List voices | `GET` | `https://api.inworld.ai/voices/v1/voices` |
| Supported languages | `GET` | `https://api.inworld.ai/voices/v1/supportedLanguages` |

Auth header: `Authorization: Basic $INWORLD_API_KEY`.

Aquilla proxies the catalog as `GET /api/v1/voice/tts/voices?projectId=&language=`
(repeat `language` for each target-language lane). The picker shows every
SYSTEM voice whose primary language matches a lane, and badges the language
on each name when the project has more than one lane.

On the TTS tab with the Inworld engine, nested **Prebuilt voice** /
**Voice design** tabs pick the source. Prebuilt is the catalog dropdown.
Voice design has **Freeform** and **Structured** modes (Inworld Portal's
tabs). Freeform describes a voice in English (30–1000 characters). Structured
is a textarea of the exact profile the model receives as `key: value` lines
(`dialect`, `gender`, `age`, `emotion`, `tone`, `pitch`, `volume`, `speed`,
`clarity`, `fluency`, `personality`, `texture`, `environment`) and posts
`designPromptMode: DESIGN_PROMPT_MODE_VERBATIM`. Both modes show five
starting-point chips under the prompt (Agent, Narrator, Companion, Instructor,
Pirate) that fill English copy for that mode; the chip labels are translated,
the inserted prompt is not. Both modes pick a
**Language** and **Accent** (one `languageCode` such as `en-US` /
`en-scottish` / `kbt` — Inworld has no separate accent field), and a preview script
(about 50–400 characters) the samples will speak. Language and Accent come
live from Inworld `GET /voices/v1/supportedLanguages`, proxied as
`GET /api/v1/voice/tts/supported-languages?projectId=`. Language is
`familyCode` / `familyDisplayName`; Accent is `accentDisplayName` (or Standard
when a family has no named accents). The saved value is the row's `code`,
sent as `languageCode` on design. If that fetch fails, the UI falls back to
the published TTS-2 table. There is no Other / typed-code field on Voice
design; that stays on Prebuilt when a project lane is not a code Inworld can
map. Generate posts `POST /api/v1/voice/tts/design`; Create/Save publishes the chosen preview
via `POST /api/v1/voice/tts/publish`. The published `voiceId` is stored on
`Voice.voiceName` like a catalog or clone id. The chosen preview clip is
uploaded project-scoped to R2 (same reference-clip path as clone audio) and
the object name is stored on `Voice.designPreviewAudioId`. Opening the voice
later plays that clip, not a new synthesize of the preview script. Voices
saved before this field existed still fall back to a fresh TTS request.

Per-voice playground knobs (New Voice dialog, Inworld engine) persist on the
`Voice` record and are sent with `POST /api/v1/voice/tts`:

| Control | Voice field | Inworld API |
| --- | --- | --- |
| Audio quality → Standard | `audioQuality: "standard"` | `modelId: inworld-tts-2-flash` |
| Audio quality → Highest | `audioQuality: "highest"` | `modelId: inworld-tts-2` |
| Delivery | `deliveryMode: STABLE \| BALANCED \| CREATIVE` | `deliveryMode` (TTS-2 only; ignored on Flash) |
| Talking speed | `speakingRate` in `[0.5, 1.5]` | `audioConfig.speakingRate` |

Unset quality/delivery follow Highest + Stable. Delivery is disabled in the UI
on Standard, because Flash ignores it. Highest quality also shows a Best
practices link to Inworld [steering](https://docs.inworld.ai/tts/capabilities/steering)
(instruction tags in the spoken text; TTS-2 only). Voice Design preview
generation does not send these knobs — the New Voice dialog says so under
Generate previews and above the controls. They apply on later
`POST /api/v1/voice/tts` with the published voice.

If any target-language lane is a display name Inworld cannot map (`French`,
`Grade 7 English`, …), the New Voice dialog shows a Language dropdown — even
when other lanes are valid codes. Pick a stock language or Other and type a
BCP-47 tag. The chosen code is stored on the voice and sent with catalog fetch
and synthesize, alongside any lanes that already mapped. Lanes that are all
ISO/BCP-47 codes skip the dropdown.

Legacy project voices with `provider: "omnivoice"` are rewritten to Inworld
the first time a project is opened (`useProjectTts`): the stored provider
becomes `inworld`, leftover language tags (`eng`, `French`, `en`) become
Inworld BCP-47 (`en-US`, `fr-FR`), and empty catalog names become Dennis.
Runtime still remaps unread copies so generate uses the hosted Inworld path
(same clone-from-reference flow).
