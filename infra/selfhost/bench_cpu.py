# CPU benchmark for the self-hosted CTC path: speed per 30 s of audio and
# character error rate (CER) against human-corrected transcripts.
#
# It times the server's own CTC class (omni_asr_server.CTC), so each number is
# what one /transcribe call costs: decode + transcription + word alignment.
# With omniASR_CTC_300M that is one forward pass; with 1B it is two (1B for
# the text, 300M for the timings).
#
# Usage (on the box, in the server's venv):
#   python bench_cpu.py manifest.json [--configs 300M:fp32,300M:int8,1B:fp32,1B:int8] [--threads N]
# manifest.json: [{"audio": "clip.wav", "text": "corrected transcript"}, ...]
# Prints one JSON line per config and a Markdown table at the end.

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from omni_asr_server import CTC, SAMPLE_RATE, _decode_wav  # noqa: E402

CARDS = {"300M": "omniASR_CTC_300M", "1B": "omniASR_CTC_1B"}


def normalize(text: str) -> str:
    """CTC models emit no punctuation or case, so compare letters only."""
    text = unicodedata.normalize("NFC", text).lower()
    text = re.sub(r"[^\w\s']", " ", text)
    return " ".join(text.split())


def edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def run(config: str, clips: list[tuple[torch.Tensor, str]]) -> dict:
    size, precision = config.split(":")
    t0 = time.time()
    ctc = CTC(CARDS[size], torch.device("cpu"), "int8" if precision == "int8" else None)
    load_sec = time.time() - t0
    with torch.inference_mode():
        ctc.transcribe(clips[0][0][: SAMPLE_RATE * 5], None)  # warm-up, not timed
        audio_sec = compute_sec = 0.0
        errors = chars = 0
        for wav, ref in clips:
            t = time.time()
            hyp, _, _ = ctc.transcribe(wav, None)
            compute_sec += time.time() - t
            audio_sec += wav.shape[0] / SAMPLE_RATE
            r, h = normalize(ref), normalize(hyp)
            errors += edit_distance(r, h)
            chars += len(r)
    return {"config": config, "clips": len(clips), "audioSec": round(audio_sec, 1),
            "secPer30sClip": round(compute_sec / audio_sec * 30, 2),
            "rtf": round(compute_sec / audio_sec, 3),
            "cer": round(errors / max(chars, 1), 4), "loadSec": round(load_sec, 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("--configs", default="300M:fp32,300M:int8,1B:fp32,1B:int8")
    ap.add_argument("--threads", type=int, default=os.cpu_count())
    args = ap.parse_args()
    torch.set_num_threads(args.threads)
    base = Path(args.manifest).parent
    items = json.load(open(args.manifest))
    clips = [(_decode_wav((base / i["audio"]).read_bytes()), i["text"]) for i in items]
    print(f"{len(clips)} clips, {torch.get_num_threads()} threads, CPU: {cpu_name()}", flush=True)
    rows = []
    for config in args.configs.split(","):
        row = run(config, clips)
        print(json.dumps(row), flush=True)
        rows.append(row)
    print("\n| Config | s per 30 s clip | RTF | CER | Load s |\n| --- | --- | --- | --- | --- |")
    for r in rows:
        print(f"| {r['config']} | {r['secPer30sClip']} | {r['rtf']} | {r['cer']:.1%} | {r['loadSec']} |")


def cpu_name() -> str:
    try:
        for line in open("/proc/cpuinfo"):
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return "unknown"


if __name__ == "__main__":
    main()
