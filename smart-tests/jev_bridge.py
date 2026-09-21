"""Run the pinned Jev policy against a caller-owned, isolated CDP page.

JSON lines on stdin/stdout are private IPC, not artifacts. Aquilla owns browser
lifecycle; Jev owns observation, decisions, freshness guards and execution.
No Browser Harness daemon or personal Chrome profile is touched.
"""

import json
import os
import re
import sys
import time

import jev_ultrafast.agent as agent_module
import jev_ultrafast.browser as browser_module
import jev_ultrafast.model as model_module


def exchange(message):
    print(json.dumps(message), flush=True)
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("Runner disconnected")
    response = json.loads(line)
    if "error" in response:
        raise RuntimeError(response["error"])
    return response.get("result", {})


def cdp(method, session_id=None, **params):
    return exchange({"type": "cdp", "method": method, "params": params})


class OwnedBrowser(browser_module.Browser):
    def __init__(self, _url):
        self.session = "runner-owned"
        self.target = None
        self.interrupted = False

    def observe(self, screenshot=True):
        # Let public accessibility loading states settle before paying for a
        # decision. This supplies no route, selector target, or next action.
        # Upstream first settles the action's input events/render frame.
        # Waiting before that frame could miss a just-mounted loading region.
        super().observe(screenshot=False)
        exchange({"type": "ready"})
        return super().observe(screenshot)

    def act(self, action, page, text=None):
        super().act(action, page, text)
        # This checkpoint precedes Jev's post-action observation. The runner
        # can leave immediately after typing, before an idle-save timer fires.
        response = exchange({
            "type": "action",
            "action": {"kind": action["kind"], "label": action["label"], "text": text},
        })
        self.interrupted = bool(response.get("stop"))


def main():
    config = json.loads(sys.stdin.readline())
    # Upstream currently fixes the decision endpoint. Keep the provider seam
    # here until upstream exposes it; never change its choice validation.
    original_post = model_module.post_json

    def configured_post(url, key, body):
        kind = "decision" if url == "https://api.typesafe.ai/v1/systemone" else "text"
        if url == "https://api.typesafe.ai/v1/systemone":
            url = os.environ.get("TYPESAFE_URL", url)
        started = time.monotonic()
        result = original_post(url, key, body)
        usage = result.get("usage", {})
        print(json.dumps({"type": "model_call", "call": {
            "kind": kind, "model": result.get("model", body.get("model")),
            "elapsedMs": round((time.monotonic() - started) * 1000),
            "usage": {key: value for key, value in usage.items()
                      if key in {"input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "total_tokens", "cost"}
                      and isinstance(value, (int, float))},
        }}), flush=True)
        return result

    model_module.post_json = configured_post
    browser_module.cdp = cdp
    agent_module.Browser = OwnedBrowser
    agent = agent_module.Agent(config["url"], config["goal"])
    started = time.monotonic()
    for _ in range(config.get("max_decisions", 60)):
        state = agent.command("tick")
        decision = state["decisions"][-1] if state["decisions"] else {}
        # Allowlist evidence. Never serialize the session, model request,
        # raw CDP traffic, network headers, or arbitrary provider responses.
        print(json.dumps({"type": "step", "step": {
            "status": state["status"],
            "elapsed_ms": state["elapsed_ms"],
            "operation": decision.get("operation"),
            "target": decision.get("target"),
            "decision_ms": decision.get("latency_ms"),
            "model": decision.get("model"),
            "actions": len(state["history"]),
            "observation": {
                "text": state["page"]["text"],
                "actions": [
                    {key: action.get(key) for key in ("kind", "label", "role")}
                    for action in state["page"]["actions"]
                ],
            },
        }}), flush=True)
        if agent.browser.interrupted:
            state["status"] = "interrupted"
            break
        if state["status"] in {"done", "blocked"}:
            break
        if time.monotonic() - started > config.get("timeout_seconds", 90):
            state["status"] = "budget_exhausted"
            break
    else:
        state["status"] = "budget_exhausted"
    print(json.dumps({"type": "result", "status": state["status"]}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # The exception class is useful evidence; its message can contain
        # private CDP expressions or provider response content.
        safe_messages = {
            "Invalid TypeSafe response; no action executed.",
            "Text helper returned no valid field value; nothing typed.",
            "Model connection failed; no action executed.",
            "Loading state did not settle", "Browser command failed",
        }
        message = str(error)
        if message not in safe_messages and not re.fullmatch(
            r"Model provider returned HTTP \d{3}; no action executed\.", message
        ):
            message = "Driver stopped without executing an unverified action"
        print(json.dumps({"type": "error", "error": type(error).__name__, "reason": message}), flush=True)
        sys.exit(2)
