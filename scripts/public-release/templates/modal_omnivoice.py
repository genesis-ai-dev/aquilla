# Generic text-to-speech service stub (public release).
#
# The real deployment wraps a third-party TTS model under its own license; that
# code and its weights are NOT included in the open-source repo. This stub
# documents the HTTP contract (`https://<acct>--omnivoice-web.modal.run`) so you
# can drop in your own model. See NOTICE.md.

import modal

app = modal.App("omnivoice-web")
image = modal.Image.debian_slim().pip_install("fastapi[standard]")


@app.function(image=image)
@modal.fastapi_endpoint(method="POST")
def synthesize(payload: dict) -> dict:
    """Bring your own TTS model.

    Expected input: { "text": str, "voice": str }
    Expected output: { "audio_url": str }
    """
    raise NotImplementedError(
        "TTS is not bundled. Deploy your own model and implement synthesize()."
    )
