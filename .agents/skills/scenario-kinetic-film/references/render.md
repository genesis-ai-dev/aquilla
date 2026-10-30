# Render, encode and check

## The pipeline

`render.py` serves the film folder on a free local port, asks the film for its length, frame rate and
cuts (`info.mjs`), splits the frames across workers, and joins the parts. Each worker (`post.py`) runs a
headless Chrome (`render.mjs`) that seeks the film to sub-frame times and captures JPEGs; Python averages
the samples of each frame (motion blur), adds bloom (a bright pass at quarter resolution, two radii) and
film grain (deterministic, so re-renders match), and pipes the frames to the encoder.

- Motion blur: a 180 degree forward shutter with 4 samples by default; blocks raise the count in fast
  windows (`f.fast`) and whips stretch the shutter (`f.smear`) to about 600 degrees with up to 24 samples.
  Samples never cross a hard cut: when a cut falls inside the shutter, the window slides back so the
  fastest frame of a whip is still blurred.
- The HUD frame counter reads the output frame time (`window.__frameT`), so blur never smears its digits.
- 1080p renders at device scale 1, 4K at 2 (the page is always 1920x1080 CSS pixels).

## Traps the scripts already handle

| Trap | Symptom | Fix in the scripts |
| --- | --- | --- |
| Headless Chrome keeps about 90 px of window chrome | the bottom of every frame is black | 1920x1300 viewport, frames clipped to 1920x1080 |
| `captureScreenshot` returns CSS pixels | a "4K" render is 1080p | `clip.scale` equals the device scale factor |
| Big 3D layers captured before every tile rasters | half-drawn words in some frames | `--run-all-compositor-stages-before-draw` |
| Too many 4K workers | memory full, the machine stalls or crashes | `render.py` sizes workers to memory (about 11 GB each at 4K) |
| A slower x264 preset without a level | the file plays in ffmpeg but not in QuickTime, Safari or on phones (Level 6.0) | `-level 5.2` at 4K, `4.2` at 1080p |
| `-shortest` when muxing | the last frames disappear | `finish.py` muxes without it |
| A tall scrolling layer at 4K | GPU memory runs out | only the rows in view exist (the Counters block recycles them) |

## Encode settings

- Masters: H.264 High, CRF 12.4, preset slower, lookahead 40, Level 5.2 (4K) or 4.2 (1080p), 4:2:0, BT.709.
  A 52 s 4K film with grain came to 0.96 GB at about 50 dB PSNR against lossless frames; CRF 11 medium is
  1.37 GB for 51 dB, which the eye cannot tell apart.
- 1080p and 9:16 versions are made from the master by `finish.py` (CRF 15, preset slow, Level 4.2).
- Override the encoder with the `ENC` environment variable for `post.py` (for example a lossless test:
  `ENC="-c:v libx264 -qp 0 -preset ultrafast"`).

## The gates in finish.py

Every file: frame count equals the film's, size under 1 GB, H.264 level 5.2 or lower, a full decode on the
macOS hardware decoder (what QuickTime uses) with no errors, loudness between -16 and -12 LUFS. The film:
40 % still frames or less before the end card, no still stretch over 0.6 s before the end card, median
motion of 2.5 px/frame or more. It prints cuts per 10 s and colour flips for reference. Hand over nothing
that does not print `ALL CHECKS PASS`.

## Other checks worth running

- `holds.py <video> 0.35 <bpm>` lists every still stretch with the beat it starts on.
- `audit.py <video>` flags frozen frames between moving ones, blank bands and single-frame flashes (a
  flash may be intended: look at it).
- `montage.py` builds labelled contact sheets from stills; `snap.mjs` takes stills at beats (`b12.5`).

## Time and memory

On a 36 GB laptop: a 24 s film renders at 1080p in about 4 minutes with 4 workers, and in 4K in about
10 minutes with 3; a 52 s film in 4K takes about 18 minutes. Render 1080p until the film passes, then 4K once.
