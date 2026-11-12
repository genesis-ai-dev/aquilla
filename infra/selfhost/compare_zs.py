# Does zero-shot (ZS 7B with examples) beat plain CTC on a language? Runs both
# on GPU, in-process with the server's own classes, and writes one JSON row
# per test clip. The CTC + LLM cleanup arm runs afterwards from the app's own
# prompt code (scripts/omni-cleanup-eval.ts reads this file's output).
#
# Examples are chosen as production chooses them: the 10 clips whose English
# source text overlaps the test clip's most (sync-worker transcription-examples),
# never the clip itself. CTC transcribes every clip, because the cleanup arm
# needs "heard" text for its example pairs.
#
# Usage (on the GPU box, with the omni-asr service stopped so both cards are free):
#   python compare_zs.py manifest.json out.json [--test 60]
# manifest.json: [{"audio": "clip.wav", "text": "reference", "english": "source text"}, ...]

import argparse
import json
import re
import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from omni_asr_server import CTC, MAX_AUDIO_SEC, SAMPLE_RATE, ZS, _decode_wav  # noqa: E402

N_EXAMPLES = 10


def words(text: str) -> set[str]:
    return set(re.findall(r"\w+", text.lower()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("out")
    ap.add_argument("--test", type=int, default=60, help="test clips, evenly spaced")
    args = ap.parse_args()
    base = Path(args.manifest).parent
    items = [i for i in json.load(open(args.manifest)) if i["text"].strip()]
    for i in items:
        i["bytes"] = (base / i["audio"]).read_bytes()
        i["wav"] = _decode_wav(i["bytes"])
    items = [i for i in items if i["wav"].shape[0] / SAMPLE_RATE < MAX_AUDIO_SEC]
    step = max(1, len(items) // args.test)
    test = items[::step][: args.test]
    print(f"{len(items)} clips under {MAX_AUDIO_SEC} s, {len(test)} test clips", flush=True)

    ctc = CTC("omniASR_CTC_1B", torch.device("cuda:0"), None)
    with torch.inference_mode():
        for n, i in enumerate(items):
            t = time.time()
            i["ctc"], _, _ = ctc.transcribe(i["wav"], None)
            i["ctcSec"] = time.time() - t
            if n % 100 == 0:
                print(f"ctc {n}/{len(items)}", flush=True)

    zs = ZS(torch.device("cuda:1"), ctc.aligner)
    rows = []
    with torch.inference_mode():
        for n, i in enumerate(test):
            src = words(i.get("english") or i["ctc"])
            pool = sorted((j for j in items if j is not i),
                          key=lambda j: -len(src & words(j.get("english") or j["ctc"])))
            examples = pool[:N_EXAMPLES]
            t = time.time()
            text, _, _ = zs.transcribe(i["wav"], [(j["bytes"], j["text"]) for j in examples])
            rows.append({"audio": i["audio"], "ref": i["text"], "english": i.get("english"),
                         "audioSec": i["wav"].shape[0] / SAMPLE_RATE,
                         "ctc": i["ctc"], "ctcSec": i["ctcSec"], "zs": text, "zsSec": time.time() - t,
                         "zsExamples": [j["audio"] for j in examples]})
            print(f"zs {n + 1}/{len(test)} {time.time() - t:.1f}s", flush=True)

    # Everything CTC heard, so the cleanup arm can build heard -> corrected pairs.
    pool = [{"audio": i["audio"], "heard": i["ctc"], "corrected": i["text"]} for i in items]
    json.dump({"test": rows, "pool": pool}, open(args.out, "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
