"""Run acoustic alignment while preserving the supplied script's paragraphs."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

from alignment_core import build_alignment_result


def run_alignment(audio_bytes, script, model, metadata, *, load_audio,
                  align_audio, device="cuda"):
    text = " ".join(script.split())
    if not text:
        raise ValueError("Provide script wording before aligning audio.")
    with TemporaryDirectory(prefix="aquilla-alignment-") as directory:
        source = Path(directory) / "source.media"
        source.write_bytes(audio_bytes)
        audio = load_audio(str(source))
        duration = len(audio) / 16000
        if duration <= 0:
            raise ValueError("Source audio contains no samples.")
        aligned = align_audio(
            [{"start": 0, "end": duration, "text": text}],
            model, metadata, audio, device,
            interpolate_method="ignore",
            return_char_alignments=False,
        )
        return build_alignment_result(
            script, aligned["word_segments"], duration,
        )
