# Tutorial videos

Short how-to videos, one per thing a person does in Aquilla ("Translate a
verse", "Validate a verse"). Each is a script that drives the real app on the
curated demo project and is filmed as it runs, with a voice saying the
script's lines. Nobody records or edits them by hand, so a video is made again
when the app changes (AQU-552).

They are built on the Showcase recorder (`e2e/recordings/README.md`), in its
doc mode. What tutorials add to it: one fixed format, a voice timed to the
screen, an Aquilla frame round the app, a way to tell when a video is out of
date, and an address the help site can read.

Each of the five videos is under a minute and shows one task from start to
finish.

| Video | For | Id |
| --- | --- | --- |
| Find your way around a project | everyone | `find-your-way-around` |
| Translate a verse | translators | `translate-a-verse` |
| Validate a verse | reviewers | `validate-a-verse` |
| Comment on a verse | everyone | `comment-on-a-verse` |
| Export your work | leads | `export-your-work` |

## Making them

```sh
eval "$(bash scripts/e2e-pg-native.sh)"   # or the aquilla-dev-pg container (e2e/README.md)
pnpm tutorials                            # say, film and put together every video
pnpm tutorials --only translate-a-verse   # one video
pnpm tutorials --skip-film                # put together the takes already filmed
pnpm tutorials --publish                  # and upload what changed, with videos.json
```

Needs ffmpeg on the PATH and Playwright's Chromium. The finished files land in
`.video-staging/tutorials/publish/` (git-ignored): for each video
`<id>/<id>.mp4`, `<id>/<id>.jpg` (the opening card, for a poster) and
`<id>/<id>.en.vtt` (captions), and `videos.json`. Nothing is uploaded without
`--publish`.

## The parts

| File | What it does |
| --- | --- |
| `e2e/recordings/tutorials/catalog.ts` | every video's id, title, who it is for, and each line its voice says |
| `e2e/recordings/specs/tutorials/<id>.showcase.ts` | the script: what is pointed at, clicked and typed, and when each line is said |
| `e2e/recordings/tutorials/tutorial.ts` | `tutorial(id, body)`: signs in to the demo project, holds each line for as long as its voice lasts, reads each line's screen for the look, fails the take when the body does |
| `e2e/recordings/tutorials/look.ts` | a video's look: each line's screen as text, steadied and hashed |
| `scripts/tutorials/voice.ts` | says each line once and keeps the recording, named by its words |
| `scripts/tutorials/cards.ts`, `brand.ts` | the frame, the opening card and the closing card, drawn by the browser in Aquilla's colours and typeface |
| `scripts/tutorials/compose.ts` | puts a video together with ffmpeg: card, take in the frame, card, voice at -16 LUFS, captions |
| `scripts/tutorials/manifest.ts` | `videos.json`, and which videos to publish again |
| `scripts/tutorials/cli.ts` | `pnpm tutorials`: all of the above in order |

## Writing one

1. Add the video to `catalog.ts`. Its first line is "Here's how to …": the
   help site shows it as the video's description. Write lines a person would
   say aloud, about what is on the screen at that moment.
2. Add `e2e/recordings/specs/tutorials/<id>.showcase.ts`:

   ```ts
   tutorial("translate-a-verse", async (t) => {
     const ws = new Workspace(t.page)
     await t.say("intro")
     await t.show.point(target)        // lead the eye
     await t.say("click")
     await ws.activateTargetCell(5)    // the e2e page object does the work
     ...
     await expect(target).toContainText(TRANSLATION)   // it must really happen
     await t.say("outro")
   })
   ```

   Drive the app with the e2e page objects (`e2e/helpers/page-objects/`), so
   a tutorial clicks what a test clicks. Every line in the catalog must be
   said, and the video must end having shown what its title promises, with an
   `expect`. A tutorial that cannot finish fails; it is never published half
   done.
3. `pnpm tutorials --only <id>` and watch the result.

Every video starts from the same place: the demo project
(`auth-worker/src/routes/marketing-seed.ts`) is seeded again at each sign-in.
The demo's content is public domain and no real project is ever filmed.

## Voice

The voice is ElevenLabs, with the two variables the Showcase assembler already
reads: `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`. A line's recording is
named by its words, so only a changed line is said again, and the recordings
are made before filming so the take can hold each line for exactly its length.

Without those variables nothing is said. The videos are filmed at reading
speed and carry captions only, and `videos.json` marks them `voiced: false`.
When the variables arrive, the next run says the lines and publishes every
video again by itself.

## The look

Each video is 1920×1080: an opening card with the title, the app in a window
under the title, and a closing card. The colours are the marketing site's ink
and azure (`aquilla-marketing/src/styles/marketing-theme.css`), the typeface
is the app's Geist, and the mark is `public/favicon-aquilla.svg`. All of it is
in `scripts/tutorials/brand.ts`.

`FRAME` in `brand.ts` is the frame's version. Raise it when a change to the
frame should publish every video again.

## When a video is published again

Each run films every video and compares it with the `videos.json` that is up.
A video is uploaded again when:

- **its screens changed**: its look differs. The look is the accessibility
  tree of the app at each line, with what differs between two runs taken out
  (the build stamp, dates, ids, "just now"). A renamed button or a new panel
  changes it; a colour does not.
- **its script changed**: a line in the catalog or a step in its spec.
- **the frame changed** (`FRAME`), or it gained or lost its voice.
- it has no film yet.

A change the look cannot see (a colour, an icon) is published by raising
`FRAME`, or by changing the script.

A video whose take fails, or that the run did not film, keeps the film that is
up, and the run fails and says which.

## On the help site

Everything is served from one place, and the addresses never change when a
video is filmed again:

```
https://docs.aquilla.app/media/tutorials/videos.json
https://docs.aquilla.app/media/tutorials/<id>/<id>.mp4
https://docs.aquilla.app/media/tutorials/<id>/<id>.jpg
https://docs.aquilla.app/media/tutorials/<id>/<id>.en.vtt
```

`videos.json`:

```json
{
  "version": 1,
  "generatedAt": "2026-11-17T20:10:00.000Z",
  "base": "https://docs.aquilla.app/media/tutorials",
  "videos": [
    {
      "id": "translate-a-verse",
      "title": "Translate a verse",
      "description": "Here's how to translate a verse.",
      "audience": "translators",
      "language": "en",
      "src": "https://docs.aquilla.app/media/tutorials/translate-a-verse/translate-a-verse.mp4",
      "poster": "https://docs.aquilla.app/media/tutorials/translate-a-verse/translate-a-verse.jpg",
      "captions": "https://docs.aquilla.app/media/tutorials/translate-a-verse/translate-a-verse.en.vtt",
      "durationSeconds": 45,
      "voiced": true,
      "filmedAt": "2026-11-17T20:10:00.000Z",
      "commit": "22143b8",
      "look": "da29c21a1bff7236",
      "script": "5f0c1e…",
      "frame": 1
    }
  ]
}
```

`aquilla-help` already has what embeds one: `src/components/Video.astro` takes
`src`, `poster`, `title` and `captions`, which are this entry's `src`,
`poster`, `title` and `captions`. A page can name a video by its fixed
addresses, or the site can read `videos.json` when it builds and list them
all.

The files live in the `aquilla-docs` R2 bucket under
`walkthroughs/tutorials/`, beside the walkthrough videos
(`docs/walkthroughs/UPLOAD-MANIFEST.tsv`), which is what
`docs.aquilla.app/media/` serves. `TUTORIALS_PUBLIC_BASE` and
`TUTORIALS_R2_PREFIX` change the address and the prefix.

## The workflow

`.github/workflows/tutorials.yml` runs `pnpm tutorials` on a GitHub runner:
by hand for now, with a box to tick to publish. Its header says what to add
to run it each night, and which secrets it reads. Every run keeps its videos
as an artifact for 14 days, published or not.

## Not done yet

- **Other languages.** A line is keyed in the catalog so it can be translated,
  and the captions file is named by language, but only English is made.
- **A check of each new film's pictures.** A take must pass its own `expect`s,
  which catch a flow that broke; nothing yet looks at the frames for a layout
  that broke.
- **YouTube.** Not planned yet; the files and `videos.json` are what a later
  upload would read.
