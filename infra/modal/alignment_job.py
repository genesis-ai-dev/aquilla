"""Execute one acoustic job and report its terminal result to the worker."""

import hmac
import re

from alignment_transport import pinned_target


def accept_alignment_job(payload, secret, spawn):
    supplied = payload.get("secret") if isinstance(payload, dict) else None
    if (not secret or not isinstance(supplied, str)
            or not hmac.compare_digest(supplied.encode(), secret.encode())):
        raise PermissionError("Invalid alignment service credentials.")
    for key in ("jobId", "script", "language", "audioUrl", "callbackUrl"):
        if not isinstance(payload.get(key), str) or not payload[key].strip():
            raise ValueError(f"Provide {key}.")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", payload["jobId"]):
        raise ValueError("Invalid alignment job identifier.")
    if len(payload["script"]) > 200_000:
        raise ValueError("Script exceeds the alignment limit.")
    if not re.fullmatch(r"[a-z]{2,3}", payload["language"]):
        raise ValueError("Provide the source language code.")
    pinned_target(payload["audioUrl"])
    pinned_target(payload["callbackUrl"])
    spawn(payload["jobId"], payload["audioUrl"], payload["callbackUrl"],
          payload["script"], payload["language"])
    return {"accepted": True, "jobId": payload["jobId"]}


def execute_alignment_job(job_id, audio_url, callback_url, script, language,
                          secret, *, fetch_audio, align, post_result):
    try:
        audio = fetch_audio(audio_url)
        result = align(audio, script, language)
        payload = {"jobId": job_id, "status": "done", "result": result}
    except Exception:
        # Model exceptions may include source wording or signed audio URLs.
        payload = {
            "jobId": job_id, "status": "failed",
            "error": "Acoustic alignment failed. Review the source language and audio.",
        }
    # A callback delivery failure must not be mistaken for a model failure.
    post_result(callback_url, secret, payload)
