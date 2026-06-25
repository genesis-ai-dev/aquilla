# Walkthrough — create an organization & change its settings

Documentation assets for the two flows, captured against the local dev stack
(seeded `dev` user, org id 28 created live during capture).

## Deliverables

| File | What it is |
| --- | --- |
| `org-setup-walkthrough.gif` | Real-app screen capture (960×600, ~22s) stitched from the 9 frames below. Drop-in for docs/Slack/issues. |
| `org-setup-walkthrough.mp4` | Same capture as H.264 video (1280×720) for embedding where GIFs are too heavy. |
| `org-setup-explainer.html` | Self-contained animated explainer — a stylized recreation with step highlights, auto-play, and a clickable stepper. No server or live app needed; open it in any browser. |
| `frames/` | The nine source PNGs, one per step (real UI). |
| `frames.txt` | ffmpeg concat list with per-step dwell times (used to rebuild the gif/mp4). |

## The flow (9 steps)

**Create an organization**
1. Click the organization switcher (sidebar top).
2. Choose **+ Create org** in the menu.
3. Type the org name and click **Create**.
4. New org becomes active, with the get-started checklist.

**Change its settings** (`/settings`, owner/maintainer only)
5. Open **Settings**, click **Rename** in the Identity card.
6. Edit the name, click **Save**.
7. New name propagates to the sidebar + breadcrumb instantly.
8. Open **Who can export** and pick a minimum export role.
9. Export floor saved (Contributor 400); settings save on the spot.

## Rebuilding the gif / mp4

From this directory:

```sh
# GIF (two-pass palette for quality)
ffmpeg -y -f concat -safe 0 -i frames.txt \
  -vf "scale=960:-1:flags=lanczos,palettegen=stats_mode=full" /tmp/palette.png
ffmpeg -y -f concat -safe 0 -i frames.txt -i /tmp/palette.png \
  -lavfi "scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" \
  org-setup-walkthrough.gif

# MP4
ffmpeg -y -f concat -safe 0 -i frames.txt \
  -vf "scale=1280:-2:flags=lanczos,format=yuv420p" -movflags +faststart -r 30 \
  org-setup-walkthrough.mp4
```

To re-capture the frames, drive the dev stack as the `dev` user (see the
`verify-dev-change` skill) and screenshot each step at 1280×800.
