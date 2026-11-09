"""Aquilla sandbox runner for Python (agent-worker, AQU-AGENT).

One process per `/exec` call. The Durable Object (src/sandbox-do.ts) starts
`timeout ... python3 /opt/aquilla/run.py <sentinel>` with the agent's code on
stdin, and this script reproduces what the 0.x Sandbox SDK's interpreter
returned: the code's stdout/stderr as it ran, the value of its last expression
(Jupyter's `Out[n]`), and the exception that stopped it. Those last two cannot
ride stdout as text without ambiguity, so they travel as one JSON line after a
sentinel the caller chose (src/run-output.ts decodes it):

    <everything the code printed>
    <sentinel>
    {"result": <JSON value or null>, "error": {"name", "message", "traceback"} | null}

Exit code 0 when the code ran to completion, 1 when it raised, or the code it
passed to sys.exit(). Keep this file dependency-free and compatible with the
image's Python (see Dockerfile); test/runner.test.ts also runs it with the
host's python3.
"""
import ast
import json
import sys
import traceback

FILENAME = "<sandbox>"


def jsonable(value):
    """What json.dumps can carry without inventing structure: JSON scalars and
    containers pass through (allow_nan=False rejects NaN/Infinity, which
    JavaScript's JSON.parse would choke on); everything else becomes its repr,
    which is what the 0.x interpreter showed as a text result."""
    if value is None:
        return None
    if isinstance(value, tuple):
        value = list(value)
    if isinstance(value, (bool, int, float, str, list, dict)):
        try:
            json.dumps(value, allow_nan=False)
            return value
        except (TypeError, ValueError):
            pass
    return repr(value)


def describe(exc):
    if isinstance(exc, SyntaxError):
        lines = traceback.format_exception_only(type(exc), exc)
    else:
        tb = exc.__traceback__
        # Drop this script's own frame so the traceback starts in the agent's code.
        lines = traceback.format_exception(type(exc), exc, tb.tb_next if tb else None)
    return {
        "name": type(exc).__name__,
        "message": str(exc),
        "traceback": "".join(lines).splitlines(),
    }


def run(source):
    """Execute the code; return (envelope, exit_code)."""
    namespace = {"__name__": "__main__", "__builtins__": __builtins__}
    try:
        tree = ast.parse(source, filename=FILENAME, mode="exec")
        tail = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            tail = tree.body.pop()
        exec(compile(tree, FILENAME, "exec"), namespace)
        if tail is None:
            return {"result": None, "error": None}, 0
        value = eval(compile(ast.Expression(tail.value), FILENAME, "eval"), namespace)
        return {"result": jsonable(value), "error": None}, 0
    except SystemExit as exc:
        code = exc.code
        if code is None or code == 0:
            return {"result": None, "error": None}, 0
        if isinstance(code, int):
            status = code if 0 < code < 256 else 1
        else:
            # sys.exit("message") prints the message and exits 1, as python would.
            print(code, file=sys.stderr)
            status = 1
        return {"result": None, "error": {"name": "SystemExit", "message": str(code), "traceback": []}}, status
    except BaseException as exc:  # noqa: BLE001 — every failure of the agent's code is reported, never re-raised
        return {"result": None, "error": describe(exc)}, 1


def main():
    sentinel = sys.argv[1]
    # Hide the sentinel from the code. Its stdin is at EOF once the source is read.
    sys.argv = [FILENAME]
    source = sys.stdin.read()
    envelope, exit_code = run(source)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:  # noqa: BLE001 — a stream the code closed must not hide the envelope
            pass
    try:
        out = sys.__stdout__
        out.write("\n" + sentinel + "\n" + json.dumps(envelope, default=repr) + "\n")
        out.flush()
    except Exception:  # noqa: BLE001 — stdout closed by the code; the exit code still tells the story
        pass
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
