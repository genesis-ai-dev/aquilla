# Generic speaker-diarization service stub (public release).
#
# The real deployment wraps a gated third-party diarization model (which
# requires accepting the model provider's conditions and supplying your own
# access token). That code is NOT included in the open-source repo. This stub
# documents the HTTP contract (`https://<acct>--diarization-web.modal.run/start`)
# so you can drop in your own model. See NOTICE.md.

import modal

app = modal.App("diarization-web")
image = modal.Image.debian_slim().pip_install("fastapi[standard]")


@app.function(image=image)
@modal.fastapi_endpoint(method="POST")
def start(payload: dict) -> dict:
    """Bring your own diarization model.

    Expected input: { "audio_url": str }
    Expected output: { "segments": [{ "start": float, "end": float, "speaker": str }] }
    """
    raise NotImplementedError(
        "Diarization is not bundled. Deploy your own model and implement start()."
    )
