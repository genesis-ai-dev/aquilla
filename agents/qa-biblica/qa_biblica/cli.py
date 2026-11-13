"""`python3 -m qa_biblica` — the operator's entry point.

Three subcommands, one per row of the "How to run" table in
`skills/README.md`:

    bootstrap   → Run qa-bootstrap-inventories on approved books
    run-book    → Run qa-run-book on [MRK]  /  on [ROM 3]
    edited      → Run qa-run-book on approved books, edited cells only

Tokens come from the environment, never from an argument: an `aqk_` token on a
command line lands in the shell history and in the process list.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .api import AgentApi, ApiError, ScopeDenied
from .bootstrap import read_decisions, termbase_import_csv
from .qa_run import run_bootstrap, run_book
from .reader import ProjectUnreachable
from .scope import ScopeError, parse_scope, read_approved_books
from .stage import ForbiddenCommand

#: Read-only token for every GET; ask-mode write token for staging.
READ_TOKEN_ENV = "AQUILLA_READ_TOKEN"
WRITE_TOKEN_ENV = "AQUILLA_WRITE_TOKEN"
HOST_ENV = "AQUILLA_SYNC_HOST"
DEFAULT_HOST = "https://api.aquilla.app/sync"


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except (ScopeError, ProjectUnreachable, ForbiddenCommand) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except ScopeDenied as exc:
        print(
            f"error: the API refused the write — scope_denied: {exc.message}\n"
            "This token is read-only. Every file this run produced is still on disk; "
            "re-run the staging step with the ask-mode write token.",
            file=sys.stderr,
        )
        return 3
    except ApiError as exc:
        print(f"error: {exc.code}: {exc.message}", file=sys.stderr)
        return 4


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="qa_biblica",
        description="Run Biblica's QA skills against an Aquilla project over the Agent API.",
    )
    parser.add_argument("--host", default=os.environ.get(HOST_ENV, DEFAULT_HOST))
    parser.add_argument("--project", required=True, help="Aquilla project id")
    parser.add_argument("--lane", default=None, help="target lane id (read from the first target row if omitted)")
    parser.add_argument("--out", default="qa-out", help="directory for the corpus, report and CSVs")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="render and guard everything, call no prepare (the CI mode)",
    )
    sub = parser.add_subparsers(required=True)

    bootstrap = sub.add_parser("bootstrap", help="Pass 0 — build the six verification CSVs")
    bootstrap.add_argument("--approved-books", required=True, help="file listing the approved books")
    bootstrap.add_argument("--key-terms", default=None, help="Biblica Key terms list CSV")
    bootstrap.set_defaults(handler=_bootstrap)

    after = sub.add_parser(
        "bootstrap-verified", help="after the team fills the Decision column: stage the baseline"
    )
    after.add_argument("--csv", required=True, action="append", help="a verified CSV (repeatable)")
    after.set_defaults(handler=_bootstrap_verified)

    run = sub.add_parser("run-book", help="Passes 1-5 on a book, or 1-4 on a chapter")
    run.add_argument("scope", help="a book (MRK) or a chapter (ROM 3)")
    run.add_argument("--source-text", default="", help="the source text named in the brief")
    run.add_argument(
        "--finding-comments",
        action="store_true",
        help="also stage one comment per finding, batched at 200 events per changeset",
    )
    run.set_defaults(handler=_run_book)

    edited = sub.add_parser("edited", help="Passes 1-3 on approved books, edited cells only")
    edited.add_argument("--approved-books", required=True)
    edited.add_argument("--edited-since", required=True, help="the approval date, YYYY-MM-DD")
    edited.add_argument(
        "--since-seq",
        type=int,
        default=None,
        help="serverSeq cursor; when given, the API's own delta read decides what changed",
    )
    edited.add_argument("--source-text", default="")
    edited.set_defaults(handler=_edited)

    return parser


# -- handlers ---------------------------------------------------------------


def _read_api(args) -> AgentApi:
    token = os.environ.get(READ_TOKEN_ENV)
    if not token:
        raise ScopeError(
            f"set {READ_TOKEN_ENV} to the read-only aqk_ token (see the runner's README)"
        )
    return AgentApi(args.host, token)


def _write_api(args) -> AgentApi:
    """The ask-mode write token, or the read-only one in dry-run.

    In a real run these are two different tokens on purpose: the reads cannot
    write, and the write token is only ever handed the staging step.
    """
    if args.dry_run:
        return _read_api(args)
    token = os.environ.get(WRITE_TOKEN_ENV)
    if not token:
        raise ScopeError(
            f"set {WRITE_TOKEN_ENV} to the ask-mode write aqk_ token, or pass --dry-run"
        )
    return AgentApi(args.host, token)


def _bootstrap(args) -> int:
    api = _read_api(args)
    books = read_approved_books(args.approved_books)
    paths, log = run_bootstrap(
        api,
        args.project,
        approved_books=books,
        out_dir=args.out,
        lane=args.lane,
        key_terms_path=args.key_terms,
    )
    for line in log:
        print(line)
    print("\nWrote:")
    for path in paths:
        print(f"  {path}")
    print(
        "\nNext: the team fills the Decision column in each CSV, then run "
        "`bootstrap-verified --csv <file>` for each one."
    )
    return 0


def _bootstrap_verified(args) -> int:
    from .baseline import render_block
    from .stage import Stager, decision

    decided = [row for path in args.csv for row in read_decisions(path)]
    if not decided:
        print("no filled Decision column found in the given CSVs — nothing to stage")
        return 1

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    termbase = termbase_import_csv(decided, out / "termbase-import.csv")

    approved = [row.item for row in decided if row.suggested.lower().startswith("approve")]
    rejected = [row.item for row in decided if row.suggested.lower().startswith("reject")]
    commands = [
        decision(
            "qa-style-characters",
            render_block({"verified": "see Linear AQU-2365", "source": "qa-bootstrap-inventories"}, approved),
            rationale="verified baseline from the approved books; the team filled every Decision",
        )
    ]
    stager = Stager(_write_api(args), args.project, dry_run=args.dry_run)
    result = stager.stage(commands)

    print(f"approved {len(approved)} item(s), rejected {len(rejected)}")
    print(f"termbase import CSV: {termbase}")
    if result.scope_denied:
        print(f"write refused (scope_denied): {result.scope_denied}")
        return 3
    _print_approvals(result)
    return 0


def _run_book(args) -> int:
    scope = parse_scope(args.scope)
    return _execute(args, scope)


def _edited(args) -> int:
    scope = parse_scope(
        "approved books, edited cells only",
        approved_books=read_approved_books(args.approved_books),
        edited_since=args.edited_since,
        since_seq=args.since_seq,
    )
    return _execute(args, scope)


def _execute(args, scope) -> int:
    result = run_book(
        _read_api(args) if args.dry_run else _write_api(args),
        args.project,
        scope,
        out_dir=args.out,
        lane=args.lane,
        source_text=getattr(args, "source_text", ""),
        dry_run=args.dry_run,
        stage_finding_comments=getattr(args, "finding_comments", False),
    )
    print(f"Scope: {scope.label} — passes {', '.join(str(p) for p in scope.passes)}")
    for line in result.report.code_log:
        print(f"  {line}")

    if result.halted:
        print(f"\nstopped: {result.halted}")
        print(f"report (what was read): {result.artifacts.report_path}")
        return 1

    print(f"\n{len(result.findings)} finding(s); {result.suppressed} already reported")
    print(f"corpus: {result.artifacts.corpus_path}")
    print(f"report: {result.artifacts.report_path}")
    if result.artifacts.new_words_path:
        print(f"new words: {result.artifacts.new_words_path}")

    staged = result.stage_result
    if staged is None:
        print("\nnothing staged — no new findings to report")
        return 0
    if getattr(staged, "scope_denied", None):
        print(f"\nwrite refused (scope_denied): {staged.scope_denied}")
        print("Every file above is still on disk. Re-run with the ask-mode write token.")
        return 3
    _print_approvals(staged)
    return 0


def _print_approvals(staged) -> None:
    urls = getattr(staged, "approval_urls", [])
    if not urls:
        print("\nstaged (dry run — nothing was sent to the API)")
        return
    print("\nNothing is written until a person approves. Open each link and click Approve:")
    for url in urls:
        print(f"  {url}")


if __name__ == "__main__":
    raise SystemExit(main())
