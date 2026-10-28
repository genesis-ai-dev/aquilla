"""
Voice forge: invent a character voice from a text description, then build an RVC
voice model for it that native-language readers can be converted into.

Pipeline (each stage is a Modal function; everything lives on the `voice-forge` Volume
under /forge/voices/<voice_id>/):

  1. design   Qwen3-TTS VoiceDesign (Apache-2.0) turns a description into N candidate
              clips of a voice that belongs to nobody. A human picks one.
  2. corpus   Qwen3-TTS Base (Apache-2.0) clones the picked clip ("design then clone",
              the workflow Qwen recommends for a stable character) and reads ~25 min of
              varied text. Clips are filtered by ECAPA similarity to the anchor and by a
              seconds-per-character sanity band, so drifted or runaway takes are dropped.
  3. train    Applio/RVC (MIT code + MIT pretrained weights) trains on the corpus.
  4. convert  Applio inference: a native reader's wav in, the character's timbre out.
              Pitch passes through (rmvpe); transpose defaults to the median-F0 gap.

Why this shape (see research_notes/Low resource voice cloning options/): RVC keeps the
reader's phonetics, timing and pitch contour — the language lives there — and only swaps
timbre. Every component is commercially licensed, unlike Seed-VC (GPL, archived).

Custom voices (a real speaker, from the org's own recordings — consent is the org's
responsibility and is recorded by the sync-worker before anything reaches here):

  ingest_clip   one uploaded recording → voices/<id>/corpus/upload-<n>.wav (mono PCM)
  custom_train  async: corpus stats + preview → train → status.json "ready" | "failed"

Usage:
  modal run infra/modal/voice_forge.py::design --voice-id fisherman \
      --description "A weathered middle-aged fisherman: warm, gravelly baritone..."
  modal run infra/modal/voice_forge.py::build --voice-id fisherman --candidate 0
  modal run infra/modal/voice_forge.py::convert --voice-id fisherman --source in.wav --output out.wav
  modal run infra/modal/voice_forge.py::fetch --voice-id fisherman --out-dir ./fisherman
"""

import json
import os
import re
import time
from pathlib import Path

import modal

FORGE = "/forge"
APPLIO_REPO = "https://github.com/IAHispano/Applio.git"
APPLIO_COMMIT = "5171e1dcf31a33d1afeb14ef7c6aac6dadae5dc1"
APPLIO_DIR = "/applio"
SR_TRAIN = 40000
DESIGN_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
DEFAULT_SAMPLE_TEXT = "Every voice tells a story. Listen closely, and you will hear mine."
# Every character's preview reads the same line, so the cast compares like for like.
PREVIEW_TEXT = "This is a sample of a default Aquilla synthetic voice."
BASE_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
# LibriTTS-R transcripts (CC-BY 4.0; the underlying books are public domain) give the
# corpus a wide spread of sentence shapes. Only the text column is used.
LIBRITTS_SHARD = (
    "https://huggingface.co/datasets/mythicinfinity/libritts_r/resolve/main/data/"
    "train.clean.100/train.clean.100-00002-of-00018.parquet"
)

app = modal.App("voice-forge")
vol = modal.Volume.from_name("voice-forge", create_if_missing=True)

qwen_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "sox", "curl")
    # speechbrain 1.0.2 calls torchaudio.list_audio_backends(), removed in torchaudio 2.9
    .pip_install("torch==2.7.1", "torchaudio==2.7.1", "qwen-tts", "soundfile", "numpy", "pyarrow",
                 "speechbrain==1.0.2", "librosa")
    .env({"HF_HOME": f"{FORGE}/hf"})
)

applio_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0", "libportaudio2", "build-essential")
    .run_commands(
        f"git clone {APPLIO_REPO} {APPLIO_DIR} && cd {APPLIO_DIR} && git checkout {APPLIO_COMMIT}",
        "pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu128",
        # keep the CUDA 12.8 torch above; drop the engine's own torch pins
        f"cd {APPLIO_DIR} && grep -v -E '^(torch|torchaudio)==' requirements-engine.txt > /tmp/req.txt"
        " && pip install -r /tmp/req.txt",
        f"cd {APPLIO_DIR} && python -c \"import core; core.run_prerequisites_script("
        "pretraineds_hifigan=False, models=True, exe=False)\"",
        f"cd {APPLIO_DIR} && python -c \"from rvc.lib.tools.prerequisites_download import "
        f"ensure_pretrained; ensure_pretrained('HiFi-GAN', {SR_TRAIN})\"",
    )
    .env({"APPLIO_LOGS_DIR": f"{FORGE}/applio_logs", "APPLIO_CONFIG_DIR": "/tmp/applio_cfg"})
)

# Lines that push the voice outside calm narration, so the RVC model has seen questions,
# exclamations, grief, laughter-adjacent and hushed delivery before a reader performs them.
EXPRESSIVE_LINES = [
    "Wait. Did you hear that? Someone is at the door.",
    "No! Put it down, you don't know what you're doing!",
    "Ha! I told you it would work. I told you!",
    "Please... please, I'm begging you, don't go.",
    "Come closer. Quietly now, they're asleep.",
    "Why would you do this? After everything we've been through?",
    "Run! Get to the boats, now!",
    "Oh, that is wonderful news. Truly wonderful.",
    "I don't know. I honestly don't know anymore.",
    "Is it true? Tell me it's true.",
    "Enough! I will not hear another word of it.",
    "Shh, shh. It's all right. I'm here.",
    "You came back. I can't believe you came back.",
    "Hurry, the light is fading and we have miles to go.",
    "What is this? Who told you that you could take it?",
    "Thank you. Thank you, from the bottom of my heart.",
    "I was wrong. I was wrong, and I am so sorry.",
    "Look at the nets! They're breaking, there are so many fish!",
    "Who is this man, that even the wind obeys him?",
    "Mother! Mother, come quickly, look who's here!",
    "Hm. Interesting. Very interesting indeed.",
    "Don't be afraid. Do you hear me? Don't be afraid.",
    "We have nothing. Not a coin, not a crust of bread.",
    "Go on, then. Ask him yourself, if you're so brave.",
    "It's cold out here. Let's build a fire and wait for morning.",
    "Ow! Careful, that's sharp.",
    "Listen to me. Listen very carefully.",
    "One, two, three... seven, eight, nine, ten. Ten baskets left over.",
    "Yes! Yes, of course I'll come with you!",
    "Where were you? We searched the whole city for you!",
]


def _voice_dir(voice_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,40}", voice_id):
        raise ValueError(f"bad voice_id {voice_id!r}")
    return Path(FORGE) / "voices" / voice_id


def _median_f0(path: str) -> float:
    import librosa
    import numpy as np

    y, _ = librosa.load(path, sr=16000)
    f0, voiced, _ = librosa.pyin(y, fmin=55, fmax=600, sr=16000, frame_length=1024, hop_length=160)
    return float(np.nanmedian(f0[voiced])) if voiced.any() else 0.0


def _corpus_text(n_lines: int, seed: int) -> list[str]:
    import random
    import subprocess

    import pyarrow.parquet as pq

    cache = Path(FORGE) / "text" / "libritts_r_shard2.json"
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        local = "/tmp/shard.parquet"
        subprocess.run(["curl", "-sSL", "-o", local, LIBRITTS_SHARD], check=True)
        texts = pq.read_table(local, columns=["text_normalized"]).column(0).to_pylist()
        keep = sorted({t.strip() for t in texts if 50 <= len(t.strip()) <= 220})
        cache.write_text(json.dumps(keep))
        vol.commit()
    pool = json.loads(cache.read_text())
    rng = random.Random(seed)
    lines = rng.sample(pool, max(0, n_lines - len(EXPRESSIVE_LINES)))
    lines += EXPRESSIVE_LINES
    rng.shuffle(lines)
    return lines


@app.cls(image=qwen_image, gpu="L4", volumes={FORGE: vol}, timeout=3 * 3600, scaledown_window=120,
         max_containers=10)
class Qwen:
    @modal.enter()
    def load(self):
        import torch
        from qwen_tts import Qwen3TTSModel
        from speechbrain.inference.speaker import EncoderClassifier

        kw = {"device_map": "cuda:0", "dtype": torch.bfloat16, "attn_implementation": "sdpa"}
        self.design_model = Qwen3TTSModel.from_pretrained(DESIGN_MODEL, **kw)
        self.base_model = Qwen3TTSModel.from_pretrained(BASE_MODEL, **kw)
        self.ecapa = EncoderClassifier.from_hparams(
            "speechbrain/spkrec-ecapa-voxceleb", savedir=f"{FORGE}/hf/ecapa", run_opts={"device": "cuda"}
        )
        vol.commit()

    def _embed(self, wav, sr):
        import librosa
        import torch

        y = librosa.resample(wav.astype("float32"), orig_sr=sr, target_sr=16000)
        return self.ecapa.encode_batch(torch.tensor(y).unsqueeze(0)).squeeze().cpu().numpy()

    @modal.method()
    def design(self, voice_id: str, description: str, sample_text: str, n: int = 4) -> dict:
        """Returns {"wavs": [...], "auto": i}. `auto` is the most central candidate by
        ECAPA similarity: the take most typical of what the description produces, which is
        a decent unattended pick when a human isn't choosing."""
        import io

        import numpy as np
        import soundfile as sf

        vdir = _voice_dir(voice_id)
        (vdir / "candidates").mkdir(parents=True, exist_ok=True)
        wavs, sr = self.design_model.generate_voice_design(
            text=[sample_text] * n, language=["English"] * n, instruct=[description] * n
        )
        out, embs = [], []
        for i, w in enumerate(wavs):
            sf.write(vdir / "candidates" / f"c{i}.wav", w, sr)
            buf = io.BytesIO()
            sf.write(buf, w, sr, format="WAV")
            out.append(buf.getvalue())
            e = self._embed(w, sr)
            embs.append(e / np.linalg.norm(e))
        sims = np.stack(embs) @ np.stack(embs).T
        auto = int(np.argmax(sims.sum(axis=1)))
        (vdir / "spec.json").write_text(json.dumps(
            {"voice_id": voice_id, "description": description, "sample_text": sample_text,
             "auto_candidate": auto, "design_model": DESIGN_MODEL, "license": "Apache-2.0 (Qwen3-TTS)"},
            indent=2))
        vol.commit()
        return {"wavs": out, "auto": auto}

    @modal.method()
    def corpus(self, voice_id: str, candidate: int = 0, minutes: float = 25.0, batch: int = 8,
               min_sim: float = 0.55, seed: int = 0) -> dict:
        import numpy as np
        import soundfile as sf

        vol.reload()
        vdir = _voice_dir(voice_id)
        spec = json.loads((vdir / "spec.json").read_text())
        anchor = vdir / "anchor.wav"
        anchor.write_bytes((vdir / "candidates" / f"c{candidate}.wav").read_bytes())
        a_wav, a_sr = sf.read(anchor)
        a_emb = self._embed(a_wav, a_sr)
        prompt = self.base_model.create_voice_clone_prompt(
            ref_audio=str(anchor), ref_text=spec["sample_text"], x_vector_only_mode=False)

        cdir = vdir / "corpus"
        cdir.mkdir(exist_ok=True)
        lines = _corpus_text(int(minutes * 60 / 6.5 * 1.35) + 20, seed)
        kept, rejected, total, t0 = [], [], 0.0, time.time()
        for start in range(0, len(lines), batch):
            if total >= minutes * 60:
                break
            chunk = lines[start:start + batch]
            wavs, sr = self.base_model.generate_voice_clone(
                text=chunk, language=["English"] * len(chunk), voice_clone_prompt=prompt)
            for text, w in zip(chunk, wavs):
                dur = len(w) / sr
                spc = dur / max(len(text), 1)
                e = self._embed(w, sr)
                sim = float(np.dot(e, a_emb) / (np.linalg.norm(e) * np.linalg.norm(a_emb)))
                rec = {"text": text, "dur": round(dur, 2), "sim": round(sim, 3)}
                # ~0.05-0.11 s/char is normal English pace; outside it the take ran away or truncated
                if sim < min_sim or not 0.035 <= spc <= 0.13:
                    rejected.append(rec)
                    continue
                name = f"{len(kept):04d}.wav"
                sf.write(cdir / name, w, sr)
                kept.append({**rec, "file": name})
                total += dur
        gen_s = time.time() - t0
        stats = {
            "voice_id": voice_id, "candidate": candidate, "kept": len(kept), "rejected": len(rejected),
            "audio_minutes": round(total / 60, 2), "generation_seconds": round(gen_s, 1),
            "realtime_factor": round(gen_s / max(total, 1), 3),
            "mean_sim": round(float(np.mean([k["sim"] for k in kept])), 3) if kept else None,
            "anchor_median_f0": round(_median_f0(str(anchor)), 1),
            # one short anchor clip under-reads pitch (fisherman: 84 Hz anchor vs ~90 Hz corpus),
            # so auto-transpose keys off the median across a spread of corpus clips
            "voice_median_f0": round(float(np.median(
                [_median_f0(str(cdir / k["file"])) for k in kept[::max(1, len(kept) // 24)]])), 1)
            if kept else 0.0,
            "gpu": "L4",
        }
        (vdir / "corpus.json").write_text(json.dumps({"stats": stats, "kept": kept, "rejected": rejected},
                                                     indent=2))
        vol.commit()
        return stats

    @modal.method()
    def preview_read(self, voice_id: str, text: str = PREVIEW_TEXT, n: int = 4) -> bytes:
        """The character reading `text` (cloned from its anchor), best of n by ECAPA
        similarity among takes at a sane pace. Fed through the trained RVC model by
        `preview_sample`, so the preview is what Change voice actually produces."""
        import io

        import numpy as np
        import soundfile as sf

        vol.reload()
        vdir = _voice_dir(voice_id)
        spec = json.loads((vdir / "spec.json").read_text())
        anchor = vdir / "anchor.wav"
        a_wav, a_sr = sf.read(anchor)
        a_emb = self._embed(a_wav, a_sr)
        prompt = self.base_model.create_voice_clone_prompt(
            ref_audio=str(anchor), ref_text=spec["sample_text"], x_vector_only_mode=False)
        wavs, sr = self.base_model.generate_voice_clone(
            text=[text] * n, language=["English"] * n, voice_clone_prompt=prompt)
        best, best_sim = wavs[0], -1.0
        for w in wavs:
            spc = len(w) / sr / max(len(text), 1)
            e = self._embed(w, sr)
            sim = float(np.dot(e, a_emb) / (np.linalg.norm(e) * np.linalg.norm(a_emb)))
            if 0.035 <= spc <= 0.13 and sim > best_sim:
                best, best_sim = w, sim
        buf = io.BytesIO()
        sf.write(buf, best, sr, format="WAV")
        return buf.getvalue()


@app.function(image=applio_image, gpu="A10G", volumes={FORGE: vol}, timeout=3 * 3600, cpu=8, memory=32768,
              max_containers=10)
def train(voice_id: str, epochs: int = 200, batch_size: int = 16) -> dict:
    import sys

    os.chdir(APPLIO_DIR)
    sys.path.insert(0, APPLIO_DIR)
    import core

    vol.reload()
    vdir = _voice_dir(voice_id)
    model = f"forge_{voice_id}"
    t0 = time.time()
    core.run_preprocess_script(model, str(vdir / "corpus"), SR_TRAIN, 8, "Automatic", False, 3.0, 0.3, "post")
    core.run_extract_script(model, "rmvpe", 8, 0, SR_TRAIN, "contentvec", None, 2)
    t1 = time.time()
    core.run_train_script(model, save_every_epoch=50, save_only_latest=True, save_every_weights=True,
                          total_epoch=epochs, sample_rate=SR_TRAIN, batch_size=batch_size, gpu=0,
                          pretrained=True, cleanup=False, index_algorithm="Auto",
                          cache_data_in_gpu=False, vocoder="HiFi-GAN", checkpointing=False)
    t2 = time.time()
    report = {"model": model, "epochs": epochs, "prep_seconds": round(t1 - t0, 1),
              "train_seconds": round(t2 - t1, 1), "gpu": "A10G"}
    (vdir / "train.json").write_text(json.dumps(report, indent=2))
    vol.commit()
    return report


def _weights(voice_id: str) -> tuple[str, str]:
    mdir = Path(FORGE) / "applio_logs" / f"forge_{voice_id}"
    pths = sorted(mdir.glob(f"forge_{voice_id}_*e_*s.pth"),
                  key=lambda p: int(p.name.split("_")[-2].rstrip("e")))
    if not pths:
        raise FileNotFoundError(f"no trained weights for {voice_id}")
    return str(pths[-1]), str(mdir / f"forge_{voice_id}.index")


# L4 rather than A10G: inference is a few GPU-seconds per line, and the sync-worker's
# metering price card (db/shared/audio-price-card.ts LIBRARY_VOICE_CONVERT_GPU) knows L4.
@app.function(image=applio_image, gpu="L4", volumes={FORGE: vol}, timeout=600, scaledown_window=300)
def convert_audio(voice_id: str, source: bytes, transpose: int | None = None, index_rate: float = 0.0) -> dict:
    """Re-voice `source` into `voice_id`. index_rate stays ~0 so the synthetic corpus's
    English phones don't leak into other languages."""
    import math
    import subprocess
    import sys

    vol.reload()
    raw, src, out = Path("/tmp/src.bin"), Path("/tmp/src.wav"), Path("/tmp/out.wav")
    raw.write_bytes(source)
    # Cell takes arrive as webm/opus, m4a or wav; Applio's loader wants plain PCM.
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-ac", "1", str(src)], check=True)
    # Pitch is measured BEFORE Applio is imported: with /applio first on sys.path and
    # its `core` loaded, librosa's numba-cached pyin fails to load ("module 'numba'
    # has no attribute 'core'") on a cold container.
    if transpose is None:
        stats = json.loads((_voice_dir(voice_id) / "corpus.json").read_text())["stats"]
        src_f0 = _median_f0(str(src))
        transpose = 0
        voice_f0 = stats.get("voice_median_f0") or stats["anchor_median_f0"]
        if src_f0 > 0 and voice_f0 > 0:
            transpose = max(-12, min(12, round(12 * math.log2(voice_f0 / src_f0))))

    os.chdir(APPLIO_DIR)
    sys.path.insert(0, APPLIO_DIR)
    import core

    pth, idx = _weights(voice_id)
    core.run_infer_script(pitch=transpose, index_rate=index_rate, volume_envelope=1.0, protect=0.33,
                          f0_method="rmvpe", input_path=str(src), output_path=str(out), pth_path=pth,
                          index_path=idx, f0_autotune=False, f0_autotune_strength=1.0,
                          proposed_pitch=False, proposed_pitch_threshold=155.0, export_format="WAV",
                          embedder_model="contentvec")
    return {"wav": out.read_bytes(), "transpose": transpose, "weights": Path(pth).name}


@app.function(image=qwen_image, volumes={FORGE: vol}, timeout=6 * 3600)
def forge_voice(spec: dict, minutes: float = 20.0, epochs: int = 150) -> dict:
    """design -> auto-pick -> corpus -> train -> card.json, skipping finished stages so a
    re-run of the cast only does the missing work."""
    vid = spec["voice_id"]
    vdir = _voice_dir(vid)
    vol.reload()
    t0 = time.time()
    if not (vdir / "spec.json").exists():
        Qwen().design.remote(vid, spec["description"], spec.get("sample_text", DEFAULT_SAMPLE_TEXT), 3)
        vol.reload()
    if not (vdir / "corpus.json").exists():
        auto = json.loads((vdir / "spec.json").read_text()).get("auto_candidate", 0)
        Qwen().corpus.remote(vid, auto, minutes)
        vol.reload()
    if not (vdir / "train.json").exists():
        train.remote(vid, epochs)
        vol.reload()
    stats = json.loads((vdir / "corpus.json").read_text())["stats"]
    card = {
        "voice_id": vid, "name": spec["name"], "tags": spec.get("tags", []),
        "description": spec["description"], "preview": "anchor.wav",
        "median_f0": stats.get("voice_median_f0") or stats["anchor_median_f0"],
        "corpus": stats, "train": json.loads((vdir / "train.json").read_text()),
        "license": "Designed with Qwen3-TTS (Apache-2.0); RVC via Applio (MIT). Synthetic voice, no real speaker.",
    }
    (vdir / "card.json").write_text(json.dumps(card, indent=2))
    vol.commit()
    return {"voice_id": vid, "wall_seconds": round(time.time() - t0, 1)}


@app.function(image=qwen_image, volumes={FORGE: vol}, timeout=1800)
def preview_sample(voice_id: str, text: str = PREVIEW_TEXT) -> dict:
    """PREVIEW_TEXT in the character's voice, through its RVC model; saved as preview.wav."""
    read = Qwen().preview_read.remote(voice_id, text)
    res = convert_audio.remote(voice_id, read, 0)
    vol.reload()
    (_voice_dir(voice_id) / "preview.wav").write_bytes(res["wav"])
    vol.commit()
    return {"voice_id": voice_id, "wav": res["wav"]}


@app.function(image=qwen_image, volumes={FORGE: vol})
def read_files(voice_id: str, names: list[str]) -> dict:
    vol.reload()
    vdir = _voice_dir(voice_id)
    return {n: (vdir / n).read_bytes() for n in names if (vdir / n).exists()}


# ----------------------------------------------------------------- custom (real-speaker) voices
# Bounds on what one custom voice may be trained from. RVC needs ~10 min to be stable;
# below 5 it audibly wobbles. Above an hour adds GPU time without adding quality.
CUSTOM_MIN_SECONDS = 5 * 60
CUSTOM_MAX_SECONDS = 60 * 60
CUSTOM_EPOCHS = 150


def _status_path(voice_id: str) -> Path:
    return _voice_dir(voice_id) / "status.json"


def _write_status(voice_id: str, **fields) -> None:
    path = _status_path(voice_id)
    current = json.loads(path.read_text()) if path.exists() else {}
    path.write_text(json.dumps({**current, **fields, "updated_at": time.time()}))
    vol.commit()


@app.function(image=applio_image, volumes={FORGE: vol}, timeout=600, cpu=2)
def ingest_clip(voice_id: str, index: int, data: bytes) -> dict:
    """Decode one uploaded recording (webm/opus, m4a, mp3, wav…) to mono 40 kHz PCM in the
    voice's corpus. Applio's preprocess slices long files itself, so no splitting here."""
    import subprocess

    import soundfile as sf

    vol.reload()
    cdir = _voice_dir(voice_id) / "corpus"
    cdir.mkdir(parents=True, exist_ok=True)
    raw, out = Path(f"/tmp/in-{index}"), cdir / f"upload-{index:03d}.wav"
    raw.write_bytes(data)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-ac", "1", "-ar", str(SR_TRAIN),
                    str(out)], check=True)
    seconds = sf.info(str(out)).duration
    vol.commit()
    return {"index": index, "seconds": round(seconds, 2)}


@app.function(image=applio_image, volumes={FORGE: vol}, timeout=4 * 3600, cpu=2)
def custom_train(voice_id: str, epochs: int = CUSTOM_EPOCHS) -> dict:
    """Train a custom voice from its ingested uploads. Spawned by the web route, which
    returns at once; progress is read back from status.json."""
    import soundfile as sf

    vol.reload()
    vdir = _voice_dir(voice_id)
    clips = sorted((vdir / "corpus").glob("upload-*.wav"))
    total = sum(sf.info(str(c)).duration for c in clips)
    try:
        if total < CUSTOM_MIN_SECONDS:
            raise ValueError(f"only {total / 60:.1f} min of audio; at least {CUSTOM_MIN_SECONDS // 60} needed")
        # Preview = the first ~10 s of the first recording; pitch from a spread of clips
        # so auto-transpose in convert_audio has the speaker's real median.
        y, sr = sf.read(str(clips[0]))
        sf.write(vdir / "anchor.wav", y[: sr * 10], sr)
        f0s = [f for f in (_median_f0(str(c)) for c in clips[:24]) if f > 0]
        stats = {"voice_id": voice_id, "kept": len(clips), "audio_minutes": round(total / 60, 2),
                 "anchor_median_f0": round(_median_f0(str(vdir / "anchor.wav")), 1),
                 "voice_median_f0": round(sorted(f0s)[len(f0s) // 2], 1) if f0s else 0.0,
                 "source": "custom-upload"}
        (vdir / "corpus.json").write_text(json.dumps({"stats": stats}, indent=2))
        _write_status(voice_id, state="training", audio_minutes=stats["audio_minutes"], started_at=time.time())
        train.remote(voice_id, epochs)
        vol.reload()
        _write_status(voice_id, state="ready")
        return {"voice_id": voice_id, "state": "ready"}
    except Exception as e:  # surfaced to the user through status.json
        _write_status(voice_id, state="failed", error=str(e)[:300])
        raise


# --- Web endpoint: the sync-worker's /api/v1/voice/convert calls this for library voices.
auth_secret = modal.Secret.from_name("voice-forge-auth", required_keys=["VOICE_FORGE_TOKEN"])


@app.function(image=modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]"),
              secrets=[auth_secret], volumes={FORGE: vol})
@modal.asgi_app()
def web():
    import hmac

    from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
    from fastapi.responses import Response

    web_app = FastAPI(title="voice-forge")

    def check(token: str) -> None:
        expected = os.environ.get("VOICE_FORGE_TOKEN", "")
        if not expected or not hmac.compare_digest(token, expected):
            raise HTTPException(status_code=401, detail="unauthorized")

    @web_app.get("/health")
    async def health():
        return {"ok": True}

    @web_app.post("/convert")
    async def convert_route(
        source: UploadFile = File(...),
        voice_id: str = Form(...),
        x_auth_token: str = Header(default=""),
    ):
        check(x_auth_token)
        try:
            _voice_dir(voice_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="bad voice_id")
        vol.reload()
        if not (_voice_dir(voice_id) / "train.json").exists():
            if _status_path(voice_id).exists():
                raise HTTPException(status_code=409, detail="voice is still training")
            raise HTTPException(status_code=404, detail="unknown voice")
        res = await convert_audio.remote.aio(voice_id, await source.read())
        return Response(content=res["wav"], media_type="audio/wav",
                        headers={"X-Transpose": str(res["transpose"])})

    def custom_dir(voice_id: str) -> Path:
        # Custom voices are minted by the sync-worker as `c-<hex>`; never touch a cast voice.
        if not re.fullmatch(r"c-[a-f0-9]{12,32}", voice_id):
            raise HTTPException(status_code=400, detail="bad custom voice_id")
        return _voice_dir(voice_id)

    @web_app.post("/voices/{voice_id}/clips")
    async def add_clip(voice_id: str, index: int = Form(...), clip: UploadFile = File(...),
                       x_auth_token: str = Header(default="")):
        check(x_auth_token)
        vdir = custom_dir(voice_id)
        vol.reload()
        if (vdir / "status.json").exists():
            raise HTTPException(status_code=409, detail="training already started")
        if not 0 <= index < 200:
            raise HTTPException(status_code=400, detail="bad clip index")
        return await ingest_clip.remote.aio(voice_id, index, await clip.read())

    @web_app.post("/voices/{voice_id}/train")
    async def start_training(voice_id: str, x_auth_token: str = Header(default="")):
        check(x_auth_token)
        vdir = custom_dir(voice_id)
        vol.reload()
        if (vdir / "status.json").exists():
            raise HTTPException(status_code=409, detail="training already started")
        uploads = list((vdir / "corpus").glob("upload-*.wav"))
        # ingest_clip writes 16-bit mono PCM at SR_TRAIN, so size gives duration without
        # decoding: refuse a too-short set here, before the caller is billed for a run.
        seconds = sum(max(0, p.stat().st_size - 44) for p in uploads) / (2 * SR_TRAIN)
        if seconds < CUSTOM_MIN_SECONDS:
            raise HTTPException(status_code=400, detail=f"only {seconds / 60:.1f} min of audio; "
                                                        f"at least {CUSTOM_MIN_SECONDS // 60} needed")
        if seconds > CUSTOM_MAX_SECONDS:
            raise HTTPException(status_code=400, detail=f"{seconds / 60:.0f} min of audio; "
                                                        f"at most {CUSTOM_MAX_SECONDS // 60} allowed")
        (vdir / "status.json").write_text(json.dumps({"state": "queued", "updated_at": time.time()}))
        vol.commit()
        await custom_train.spawn.aio(voice_id)
        return {"voice_id": voice_id, "state": "queued"}

    @web_app.get("/voices/{voice_id}/status")
    async def status(voice_id: str, x_auth_token: str = Header(default="")):
        check(x_auth_token)
        vdir = custom_dir(voice_id)
        vol.reload()
        if (vdir / "train.json").exists():
            return {"voice_id": voice_id, "state": "ready"}
        if not (vdir / "status.json").exists():
            raise HTTPException(status_code=404, detail="unknown voice")
        return {"voice_id": voice_id, **json.loads((vdir / "status.json").read_text())}

    @web_app.get("/voices/{voice_id}/preview")
    async def preview(voice_id: str, x_auth_token: str = Header(default="")):
        check(x_auth_token)
        anchor = custom_dir(voice_id) / "anchor.wav"
        vol.reload()
        if not anchor.exists():
            raise HTTPException(status_code=404, detail="no preview yet")
        return Response(content=anchor.read_bytes(), media_type="audio/wav")

    return web_app


# ----------------------------------------------------------------- local entrypoints
@app.local_entrypoint()
def design(voice_id: str, description: str, n: int = 4, out_dir: str = "",
           sample_text: str = DEFAULT_SAMPLE_TEXT):
    out = Path(out_dir or f"voice_forge_{voice_id}")
    out.mkdir(parents=True, exist_ok=True)
    res = Qwen().design.remote(voice_id, description, sample_text, n)
    for i, wav in enumerate(res["wavs"]):
        (out / f"candidate_{i}.wav").write_bytes(wav)
    print(f"wrote {n} candidates to {out} (auto pick: {res['auto']}); run ::build --candidate <i>")


@app.local_entrypoint()
def build(voice_id: str, candidate: int = 0, minutes: float = 25.0, epochs: int = 200):
    stats = Qwen().corpus.remote(voice_id, candidate, minutes)
    print(json.dumps(stats, indent=2))
    print(json.dumps(train.remote(voice_id, epochs), indent=2))


@app.local_entrypoint()
def convert(voice_id: str, source: str, output: str, transpose: int = 99, index_rate: float = 0.0):
    res = convert_audio.remote(voice_id, Path(source).read_bytes(), None if transpose == 99 else transpose,
                               index_rate)
    Path(output).write_bytes(res["wav"])
    print(f"wrote {output} (transpose {res['transpose']}, {res['weights']})")


@app.local_entrypoint()
def fetch(voice_id: str, out_dir: str):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for name, data in read_files.remote(
            voice_id, ["spec.json", "corpus.json", "train.json", "anchor.wav", "corpus/0000.wav",
                       "corpus/0001.wav", "corpus/0002.wav"]).items():
        (out / name.replace("/", "_")).write_bytes(data)
    print("wrote", sorted(p.name for p in out.iterdir()))


@app.local_entrypoint()
def cast(spec_file: str = "infra/modal/voice_forge_cast.json", minutes: float = 20.0, epochs: int = 150):
    specs = json.loads(Path(spec_file).read_text())
    for res in forge_voice.map(specs, kwargs={"minutes": minutes, "epochs": epochs}, return_exceptions=True):
        print(res)


@app.local_entrypoint()
def catalog(out_dir: str, spec_file: str = "infra/modal/voice_forge_cast.json"):
    """Pull every voice's card.json + preview into out_dir/<voice_id>/."""
    for spec in json.loads(Path(spec_file).read_text()):
        vid = spec["voice_id"]
        files = read_files.remote(vid, ["card.json", "anchor.wav"])
        if not files:
            print("missing", vid)
            continue
        (Path(out_dir) / vid).mkdir(parents=True, exist_ok=True)
        for name, data in files.items():
            (Path(out_dir) / vid / name).write_bytes(data)
        print("fetched", vid, sorted(files))


@app.local_entrypoint()
def previews(out_dir: str = "public/character-voices", spec_file: str = "infra/modal/voice_forge_cast.json"):
    """Re-read every character's preview with PREVIEW_TEXT; writes out_dir/<voice_id>.wav."""
    ids = [s["voice_id"] for s in json.loads(Path(spec_file).read_text())]
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    for res in preview_sample.map(ids, return_exceptions=True):
        if isinstance(res, Exception):
            print("failed", res)
            continue
        (Path(out_dir) / f"{res['voice_id']}.wav").write_bytes(res["wav"])
        print("wrote", res["voice_id"])
