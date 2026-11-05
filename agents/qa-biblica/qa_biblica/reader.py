"""Turning a scope into a corpus, over plain GETs.

Scale rules from the issue, all of them here rather than scattered through the
checks: page with `cursor`; `terms/consistency?fileId=` per book; one request at
a time; and never read a file the scope does not need.
"""

from __future__ import annotations

from datetime import datetime, timezone

from .api import AgentApi, ApiError, PermissionDenied
from .corpus import Corpus, build_corpus, parse_ref
from .scope import Scope, ScopeMode


class ProjectUnreachable(RuntimeError):
    """The token cannot see the project. Raised at the bootstrap read."""


def resolve_project(api: AgentApi, project_id: str) -> dict:
    """Confirm the token can reach the project, before anything else runs.

    `GET /projects` is the bootstrap read (`docs/api/QUICKSTART.md` Option A
    step 2), so a token that cannot reach the project fails here with a message
    naming what it *can* reach — not twenty reads later with a confusing 403.
    """
    try:
        projects = api.projects()
    except PermissionDenied as exc:
        raise ProjectUnreachable(
            f"GET /projects was refused: {exc.message}. The credential's live role is "
            "resolved per call, so this is the minting user's access, not a runner bug."
        ) from exc
    except ApiError as exc:
        raise ProjectUnreachable(f"GET /projects failed ({exc.code}): {exc.message}") from exc

    for project in projects:
        if project.get("id") == project_id:
            return project
    reachable = ", ".join(str(p.get("id")) for p in projects) or "none"
    raise ProjectUnreachable(
        f"this token cannot read project {project_id}. Projects it can reach: {reachable}. "
        "Ask the project owner to mint a token scoped to this project."
    )


def resolve_lane(api: AgentApi, project_id: str, files: list[dict], given: str | None) -> str:
    """The lane id every lane-required read needs.

    `quality` and `terms/consistency` require `lane=`; the cells read does not.
    When the operator did not name one, it is read off the first target row
    rather than guessed — an empty legacy tag is still a lane id, not "all
    lanes" (`GET …/files/:fileId/cells` discovery note).
    """
    if given:
        return given
    for file_row in files:
        file_id = file_row.get("fileId") or file_row.get("id")
        if not file_id:
            continue
        rows, _ = api.cells(project_id, str(file_id), limit=50)
        for row in rows:
            if row.get("side") == "target" and row.get("laneId"):
                return str(row["laneId"])
    raise RuntimeError(
        "could not determine the target lane — pass --lane with the lane id from "
        "GET /api/v1/external/projects/<id> (settings), since an omitted lane is not a default"
    )


def files_for_books(api: AgentApi, project_id: str, files: list[dict], books: tuple[str, ...]) -> dict[str, list[str]]:
    """book code → the file ids holding it.

    Matched on the file name first, because that is free. Only when a book has
    no name match does the reader probe files' first page of cells for a
    canonical reference in that book — which is what keeps a 66-book project
    from being read end to end to answer "which file is MRK".
    """
    wanted = {book.upper() for book in books}
    found: dict[str, list[str]] = {book: [] for book in wanted}
    unmatched_files: list[str] = []
    for file_row in files:
        file_id = str(file_row.get("fileId") or file_row.get("id") or "")
        name = str(file_row.get("name") or file_row.get("fileName") or "").upper()
        if not file_id:
            continue
        hit = next((book for book in wanted if book in name), None)
        if hit:
            found[hit].append(file_id)
        else:
            unmatched_files.append(file_id)

    missing = [book for book, ids in found.items() if not ids]
    for file_id in unmatched_files:
        if not missing:
            break
        rows, _ = api.cells(project_id, file_id, limit=50)
        books_in_file = {
            ref.book
            for row in rows
            if (ref := parse_ref(row.get("canonicalRef"))) is not None
        }
        for book in list(missing):
            if book in books_in_file:
                found[book].append(file_id)
                missing.remove(book)
    return found


def read_corpus(
    api: AgentApi,
    project_id: str,
    scope: Scope,
    *,
    lane: str,
    files: list[dict],
) -> tuple[Corpus, list[str]]:
    """Read every cell the scope needs, and nothing else.

    Returns the corpus plus a log of what was read, which becomes the report's
    code-output block.
    """
    log: list[str] = []
    snapshot = datetime.now(timezone.utc).isoformat(timespec="seconds")
    corpus = Corpus(project_id=project_id, lane_id=lane, snapshot_at=snapshot)
    by_book = files_for_books(api, project_id, files, scope.books)
    names = {
        str(f.get("fileId") or f.get("id")): str(f.get("name") or f.get("fileName") or "")
        for f in files
    }

    changed_ids: set[str] | None = None
    for book, file_ids in by_book.items():
        if not file_ids:
            log.append(f"{book}: no file in this project holds it — nothing read")
            continue
        for file_id in file_ids:
            rows, envelope = api.cells(
                project_id,
                file_id,
                lane=lane,
                since=scope.since_seq if scope.mode is ScopeMode.APPROVED_EDITED else None,
            )
            if envelope.get("delta"):
                changed_ids = (changed_ids or set()) | set(envelope.get("changedCellIds") or [])
            verses = build_corpus(
                rows,
                project_id=project_id,
                lane_id=lane,
                snapshot_at=snapshot,
                file_id=file_id,
                start_index=len(corpus.verses),
            )
            in_scope = [v for v in verses if scope.includes(v.book, v.chapter)]
            corpus.verses.extend(in_scope)
            corpus.file_names[file_id] = names.get(file_id, "")
            log.append(
                f"{book} ({names.get(file_id) or file_id}): {len(rows)} rows read, "
                f"{len(in_scope)} cells in scope"
            )

    if scope.mode is ScopeMode.APPROVED_EDITED:
        corpus, note = _restrict_to_edited(corpus, scope, changed_ids)
        log.append(note)

    corpus.verses.sort(key=lambda v: (v.ref.sort_key if v.ref else ("", 0, 0), v.index))
    log.append(f"corpus: {len(corpus)} cells, snapshot {snapshot}")
    return corpus, log


def _restrict_to_edited(
    corpus: Corpus, scope: Scope, changed_ids: set[str] | None
) -> tuple[Corpus, str]:
    """Keep only cells edited since approval.

    Two sources, in order of authority:

    1. the cells endpoint's own `since=<serverSeq>` delta read, when the
       operator supplied a cursor — the server decides what changed;
    2. otherwise `lastEditAt` against the approval date.

    Either way a cell that was not edited since the given date leaves the corpus
    entirely, so it cannot produce a finding.
    """
    if changed_ids is not None:
        filtered = corpus.filter(lambda v: v.cell_id in changed_ids)
        return filtered, (
            f"edited-cells mode: since=<serverSeq {scope.since_seq}> delta read reported "
            f"{len(changed_ids)} changed cell(s); {len(filtered)} in scope"
        )
    cutoff = scope.edited_since_ms or 0
    filtered = corpus.filter(lambda v: v.last_edit_at > cutoff)
    return filtered, (
        f"edited-cells mode: {len(filtered)} of {len(corpus)} cells edited after "
        f"{scope.edited_since_ms} (epoch ms); the rest produce no findings"
    )


def read_builtin_checks(api: AgentApi, project_id: str) -> set[str]:
    """The built-in checks in force on the project, by check name.

    qa-run-book.md → Procedure 2 says to read Aquilla's Violations inbox first
    so built-in findings are not reported twice, and to cite them by check name
    only. The Agent API has **no per-cell violations read** today — `quality` is
    file-level health and coverage (the issue files the per-cell read as a
    follow-up). So what the runner can honestly know is *which checks are on*,
    from the project's effective `builtinChecks`.

    That is enough for the deduplication the skill file actually asks for: a
    pass whose finding duplicates an enabled built-in cites it instead of
    restating it. It is not enough to drop the finding entirely, and the runner
    does not pretend otherwise — `qa_run.NOT_CHECKED` says so in the report.
    """
    try:
        body = api.project(project_id)
    except ApiError:
        return set()
    names: set[str] = set()
    for check in body.get("builtinChecks") or []:
        if check.get("enabled") and check.get("name"):
            names.add(str(check["name"]))
    return names
