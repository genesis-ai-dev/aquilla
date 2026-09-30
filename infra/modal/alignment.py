"""Aquilla acoustic script alignment on a Modal GPU.

Run a real model check:
  modal run infra/modal/alignment.py --audio <media> --script <text>
"""

from pathlib import Path

import modal

app = modal.App("aquilla-alignment")
app_secret = modal.Secret.from_name("aquilla-alignment")
transport_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("httpx==0.28.1", "fastapi[standard]==0.116.1")
    .add_local_file(Path(__file__).with_name("alignment_transport.py"),
                    "/root/alignment_transport.py")
    .add_local_file(Path(__file__).with_name("alignment_job.py"),
                    "/root/alignment_job.py")
)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("whisperx==3.8.6")
    .add_local_file(Path(__file__).with_name("alignment_core.py"),
                    "/root/alignment_core.py")
    .add_local_file(Path(__file__).with_name("alignment_model.py"),
                    "/root/alignment_model.py")
)


@app.cls(image=image, gpu="T4", timeout=1800, scaledown_window=120)
class AcousticAligner:
    @modal.enter()
    def load(self):
        self.models = {}

    @modal.method()
    def align(self, audio_bytes: bytes, script: str, language: str):
        import whisperx
        from alignment_model import run_alignment

        if not language or not language.isalpha():
            raise ValueError("Provide a supported source language code.")
        language = language.lower()
        if language not in self.models:
            # Keep one language model resident to bound GPU memory.
            self.models.clear()
            self.models[language] = whisperx.load_align_model(
                language_code=language, device="cuda",
            )
        model, metadata = self.models[language]
        return run_alignment(
            audio_bytes, script, model, metadata,
            load_audio=whisperx.load_audio, align_audio=whisperx.align,
        )


@app.function(image=transport_image, secrets=[app_secret], timeout=1800)
def run_job(job_id: str, audio_url: str, callback_url: str,
            script: str, language: str):
    import os
    from alignment_job import execute_alignment_job
    from alignment_transport import fetch_audio, post_result

    execute_alignment_job(
        job_id, audio_url, callback_url, script, language,
        os.environ["ALIGNMENT_SHARED_SECRET"], fetch_audio=fetch_audio,
        align=AcousticAligner().align.remote, post_result=post_result,
    )


@app.function(image=transport_image, secrets=[app_secret])
@modal.fastapi_endpoint(method="POST")
def start(payload: dict):
    import os
    from fastapi import HTTPException
    from alignment_job import accept_alignment_job

    try:
        return accept_alignment_job(
            payload, os.environ["ALIGNMENT_SHARED_SECRET"], run_job.spawn,
        )
    except PermissionError as error:
        raise HTTPException(status_code=401, detail=str(error)) from None
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


@app.local_entrypoint()
def main(audio: str, script: str, output: str, language: str = "en"):
    import json

    result = AcousticAligner().align.remote(
        Path(audio).read_bytes(), Path(script).read_text(), language,
    )
    Path(output).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"Aligned {len(result['segments'])} paragraphs; saved {output}")
