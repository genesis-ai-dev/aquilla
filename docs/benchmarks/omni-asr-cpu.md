# Omnilingual ASR on CPU, and does zero-shot earn its GPU? (AQU-2222)

Measured 2026-10-27 on the LAN box (Threadripper PRO 5955WX, 16 cores; 2× RTX 4090)
with the Blackfoot Gospel of John recordings: 868 per-verse clips (4.6 h, one
reader), each with its written Blackfoot verse as the reference. 854 are under
the 40 s limit.

**Verdict.** Zero-shot is clearly the best transcription, and it needs a GPU. A CPU
server can only run CTC, which makes about twice as many errors on Blackfoot. So
a Hetzner AX CPU box is good enough only as a CTC fallback, not as the primary.

## 1. Zero-shot vs CTC vs CTC + LLM cleanup

60 test clips (19.3 min), evenly spaced. Each arm only sees *other* clips:
ZS gets the 10 clips whose English source overlaps most (production's rule);
the cleanup gets the 8 heard→corrected pairs whose CTC text overlaps most
(`pickCleanupPairs`' rule), through the app's own `buildCleanupMessages` /
`parseCleanupResult`, model `openai/gpt-5.6-luna`.

| Arm | CER | CER, diacritics folded | Time per clip | LLM cost per clip |
| --- | --- | --- | --- | --- |
| CTC 1B (GPU) | 39.8% | 27.4% | 0.09 s | — |
| CTC 1B + cleanup, production cap (1,200 tokens) | 39.4% | — | 10.8 s | $0.0014 |
| CTC 1B + cleanup, 4,000 tokens | 30.2% | 19.7% | 14.2 s | $0.0022 |
| **ZS 7B, 10 examples (GPU)** | **21.2%** | **9.5%** | 4.8 s | — |

"Diacritics folded" drops accents and `ʼ` and collapses doubled letters, so it
counts wrong sounds rather than spelling. On that measure ZS makes half the
errors of the best cleanup run and a third of plain CTC's.

**Production bug found on the way.** At `CLEANUP_MAX_TOKENS = 1200`, 49 of 60
cleanup calls were cut off (`finish_reason: "length"`): gpt-5.6-luna spent a mean
of 1,448 and up to 2,588 reasoning tokens before writing its JSON. The parser
calls that `invalid`, and the app silently keeps the heard text, so on Blackfoot
the cleanup step almost never runs. Raising the cap (or lowering reasoning
effort) is a separate fix.

Not measured: ZS followed by the cleanup.

## 2. CTC on CPU

40 clips (12.8 min, under 40 s each), evenly spaced. Time is one `/transcribe`
call end to end: decode, transcription and word alignment.

| Config | Threads | s per 30 s clip | CER |
| --- | --- | --- | --- |
| 300M fp32 | 16 | 1.71 | 35.3% |
| 300M int8 | 16 | 1.56 | 35.5% |
| 1B fp32 | 16 | 5.56 | 38.2% |
| 1B int8 | 16 | 4.50 | 37.9% |
| 300M fp32 | 8 (pinned) | 2.42 | 35.3% |
| 300M int8 | 8 (pinned) | 1.94 | 35.7% |

- **300M beats 1B on Blackfoot**, and it is 3× faster. With 300M one forward
  pass gives both the text and the timings.
- **int8 buys 10–20%** at no real cost in accuracy. Worth turning on for CPU.
- 8 pinned Zen 3 cores are a fair stand-in for an AX42's 8 Zen 4 cores
  (probably a bit slower than the real thing).

## 3. Hosting options

| Option | Monthly | Serves | Notes |
| --- | --- | --- | --- |
| LAN box (2× 4090), via Cloudflare Tunnel | power only | CTC + ZS, always warm | Primary. ZS peaks at 15.1 GiB; fits one 24 GB card. |
| Hetzner AX42 (8 cores) | €79 + €49 setup | CTC 300M int8 only, ~2 s per 30 s clip | One request at a time per box; no ZS. |
| Hetzner GEX45 (GPU) | €214 + €209 setup | CTC + ZS if the card has ≥ 20 GB | GEX44 (RTX 4000 Ada, 20 GB, €184) appears discontinued; check the current card. |
| Modal L4 | per second | CTC + ZS | Current fallback; cold start up to ~100 s. |

**Recommendation.** Keep the LAN box as `OMNI_ASR_PRIMARY_URL` and Modal as the
fallback. Don't buy an AX box to replace either: it can't serve the model that
wins. If the LAN box's uptime proves a problem, a Hetzner GPU server is the
right replacement, after checking its card holds 15 GiB for ZS.

## Caveats

- One reader, one book, 60 and 40 test clips. The references are the published
  verses, so a reader's departures from the text count as errors for every arm.
- ZS examples come from the same reader, which flatters ZS compared with a new
  speaker.
- The GPU comparison and the CPU table use different test clips; compare CER
  within a table, not across them.

## Reproduce

```bash
# on the GPU box, service stopped (both cards free)
python infra/selfhost/compare_zs.py manifest.json compare.json --test 60
python infra/selfhost/bench_cpu.py manifest_cpu40.json --threads 8   # CUDA_VISIBLE_DEVICES=
# on a machine with an OpenRouter key
OPENROUTER_API_KEY=… npx tsx scripts/omni-cleanup-eval.ts compare.json --max-tokens 4000
```

`manifest.json` is `[{audio, text, english}]`, built from the project's
per-line audio export (`manifest.csv` gives each file's `cell_id`) joined to the
cells' target and source text.
