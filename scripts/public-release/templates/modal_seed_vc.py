# Generic voice-conversion service stub (public release).
#
# The real deployment wraps a third-party voice-conversion model under its own
# license. That code and its model weights are intentionally NOT included in the
# open-source repo. This stub documents the HTTP contract the app expects
# (`https://<acct>--seed-vc-web.modal.run/convert`) so you can drop in your own
# model. See NOTICE.md.

import modal

app = modal.App("seed-vc-web")
image = modal.Image.debian_slim().pip_install("fastapi[standard]")


@app.function(image=image)
@modal.fastapi_endpoint(method="POST")
def convert(payload: dict) -> dict:
    """Bring your own voice-conversion model.

    Expected input: { "source_audio_url": str, "reference_audio_url": str }
    Expected output: { "converted_audio_url": str }
    """
    raise NotImplementedError(
        "Voice conversion is not bundled. Deploy your own model and implement convert()."
    )
