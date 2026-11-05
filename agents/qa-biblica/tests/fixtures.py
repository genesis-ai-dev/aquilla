"""Fixture corpora in three scripts, plus a fake API.

Three scripts because the checks behave differently in each: Latin exercises
capitalization and look-alike code points, Arabic exercises the caseless path
and Eastern Arabic-Indic digits, and the plain-text corpus is the clean control
that must produce no findings at all.
"""

from __future__ import annotations

import json
from typing import Any

from qa_biblica.baseline import Baseline
from qa_biblica.corpus import Corpus, Verse, parse_ref

SNAPSHOT = "2026-11-03T00:00:00+00:00"


def verse(
    ref: str,
    source: str,
    target: str,
    *,
    cell_id: str | None = None,
    index: int = 0,
    validated: bool = False,
    last_edit_at: int = 0,
    target_raw: str | None = None,
) -> Verse:
    parsed = parse_ref(ref)
    return Verse(
        cell_id=cell_id or f"cell-{ref.replace(' ', '-').replace(':', '-')}",
        file_id="file-1",
        ref=parsed,
        raw_ref=ref,
        source=source,
        target=target,
        target_raw=target if target_raw is None else target_raw,
        validated=validated,
        last_edit_at=last_edit_at,
        index=index,
    )


def corpus(*verses: Verse, project_id: str = "proj-1", lane: str = "lane-1") -> Corpus:
    out = Corpus(project_id=project_id, lane_id=lane, snapshot_at=SNAPSHOT)
    for position, item in enumerate(verses):
        item.index = position
        out.verses.append(item)
    out.file_names["file-1"] = "MRK.usfm"
    return out


# ---------------------------------------------------------------------------
# Latin-script corpus (clean control + the planted faults each test wants)
# ---------------------------------------------------------------------------


def latin_baseline() -> Baseline:
    words = {
        "the", "and", "god", "loved", "world", "so", "that", "he", "gave", "his",
        "one", "only", "son", "whoever", "believes", "in", "him", "shall", "not",
        "perish", "but", "have", "eternal", "life", "for", "came", "into", "to",
        "save", "jesus", "said", "them", "truly", "tell", "you", "Law", "light",
    }
    return Baseline(
        characters=set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
        | set(".,;:?!’“”()-0123456789"),
        punctuation={".": "none|space", ",": "none|space"},
        quotations=[("“", "”")],
        conventions={"Law": "Law"},
        number_style={"1-10": "digits", "11-100": "digits", ">100": "digits"},
        approved_words=words,
        incorrect_words={"beleives": "believes"},
        names={"Jesus": "Jesus"},
        abbreviations={"etc"},
        cased_script=True,
        verified_on="2026-10-01",
    )


def latin_clean() -> Corpus:
    """Every cell matches the baseline — the control that must stay silent."""
    return corpus(
        verse("JHN 3:16", "For God so loved the world.", "For God so loved the world."),
        verse("JHN 3:17", "For God did not send his Son into the world.", "For God came into the world to save."),
        verse("JHN 3:18", "Whoever believes in him shall not perish.", "Whoever believes in him shall not perish."),
    )


# ---------------------------------------------------------------------------
# Arabic-script corpus — caseless, Eastern Arabic-Indic digits
# ---------------------------------------------------------------------------


def arabic_baseline() -> Baseline:
    return Baseline(
        characters=set("ابتثجحخدذرزسشصضطظعغفقكلمنهوي") | set("ىءآأإئؤة") | set(" ٠١٢٣٤٥٦٧٨٩،.؟"),
        punctuation={"،": "none|space", ".": "none|space"},
        conventions={},
        number_style={"1-10": "digits", "11-100": "digits", ">100": "digits"},
        approved_words={"الله", "احب", "العالم", "هكذا", "ابنه", "الوحيد"},
        cased_script=False,
        verified_on="2026-10-01",
    )


def arabic_clean() -> Corpus:
    return corpus(
        verse("JHN 3:16", "For God so loved the world", "هكذا احب الله العالم"),
        verse("JHN 3:17", "He gave his only Son", "ابنه الوحيد"),
    )


# ---------------------------------------------------------------------------
# A fake API — records every call, serves canned pages
# ---------------------------------------------------------------------------


class FakeApi:
    """Stands in for `AgentApi`, recording calls and failing where asked.

    Deliberately not a mock library: the tests assert on the *sequence* of
    reads (GET /projects first) and on what was never called (prepare, in a
    dry run), and a recorded list reads better for both than a mock's history.
    """

    def __init__(
        self,
        *,
        projects: list[dict] | None = None,
        files: list[dict] | None = None,
        cells: dict[str, list[dict]] | None = None,
        memory: dict | None = None,
        terms: list[dict] | None = None,
        consistency: dict | None = None,
        comments: list[dict] | None = None,
        project_detail: dict | None = None,
        prepare_error: Exception | None = None,
        autonomy: str = "ask",
    ) -> None:
        self._projects = projects if projects is not None else [{"id": "proj-1", "name": "Algerian Arabic"}]
        self._files = files if files is not None else [{"fileId": "file-1", "name": "MRK.usfm"}]
        self._cells = cells or {}
        self._memory = memory or {"brief": {"content": ""}, "data": []}
        self._terms = (
            terms
            if terms is not None
            else [
                {
                    "conceptId": "k-default",
                    "sourceTerm": "gospel",
                    "status": "active",
                    "renderings": [{"rendering": "gospel", "status": "preferred"}],
                }
            ]
        )
        self._consistency = consistency or {"data": [], "scannedCells": 0, "flaggedCellCount": 0}
        self._comments = comments or []
        self._project_detail = project_detail or {"id": "proj-1", "builtinChecks": []}
        self._prepare_error = prepare_error
        self._autonomy = autonomy
        self.calls: list[str] = []
        self.prepared: list[list[dict]] = []
        self.committed: list[str] = []

    # reads
    def projects(self) -> list[dict]:
        self.calls.append("GET /projects")
        return self._projects

    def project(self, project_id: str) -> dict:
        self.calls.append(f"GET /projects/{project_id}")
        return self._project_detail

    def files(self, project_id: str) -> list[dict]:
        self.calls.append("GET /files")
        return self._files

    def cells(self, project_id, file_id, *, lane=None, since=None, limit=500):
        self.calls.append(f"GET /cells {file_id} since={since}")
        rows = self._cells.get(file_id, [])
        if since is not None:
            changed = [r["cellId"] for r in rows if r.get("_changed")]
            return rows, {"delta": True, "changedCellIds": changed, "nextCursor": None}
        return rows, {"nextCursor": None}

    def cell_history(self, project_id, cell_id):
        self.calls.append(f"GET /history {cell_id}")
        return []

    def terms(self, project_id, *, status=None):
        self.calls.append("GET /terms")
        return self._terms

    def term_consistency(self, project_id, *, lane, file_id=None, only_drift=False):
        self.calls.append("GET /terms/consistency")
        return self._consistency

    def memory(self, project_id, *, status=None, kind=None):
        self.calls.append("GET /memory")
        return self._memory

    def comments(self, project_id, *, file_id=None, cell_id=None):
        self.calls.append("GET /comments")
        return self._comments

    def quality(self, project_id, *, lane, file_id=None):
        self.calls.append("GET /quality")
        return {}

    # writes
    def prepare(self, project_id, commands):
        self.calls.append("POST /changesets")
        if self._prepare_error:
            raise self._prepare_error
        self.prepared.append(commands)
        return {
            "changeset": {"id": f"cs-{len(self.prepared)}", "autonomyMode": self._autonomy},
            "digest": "sha256:deadbeef",
            "summary": {"commands": len(commands)},
            "approvalUrl": f"https://aquilla.app/approve/cs-{len(self.prepared)}",
        }

    def commit(self, project_id, changeset_id, *, approval_url=None):
        self.calls.append("POST /commit")
        self.committed.append(changeset_id)
        if self._autonomy == "ask":
            from qa_biblica.api import ConfirmationRequired

            raise ConfirmationRequired("a human must approve", approval_url, changeset_id)
        return {"receipt": {"ok": True}}


def cell_rows(*verses: Verse, changed: set[str] | None = None) -> list[dict]:
    """Render fixture verses back into the API's two-row-per-cell shape."""
    rows: list[dict] = []
    for item in verses:
        marked = changed is not None and item.cell_id in changed
        rows.append(
            {
                "cellId": item.cell_id,
                "side": "source",
                "value": item.source,
                "canonicalRef": item.raw_ref,
                "laneId": None,
                "_changed": marked,
            }
        )
        rows.append(
            {
                "cellId": item.cell_id,
                "side": "target",
                "value": item.target,
                "canonicalRef": item.raw_ref,
                "laneId": "lane-1",
                "validated": item.validated,
                "aiDrafted": False,
                "lastEditor": "u_abcd1234",
                "lastEditAt": item.last_edit_at,
                "_changed": marked,
            }
        )
    return rows


def memory_with_baseline(**overrides: Any) -> dict:
    """A `GET …/memory` response carrying an approved baseline."""
    from qa_biblica.baseline import render_block
    from qa_biblica.stage import baseline_slug

    lists = {
        "style/characters": (
            {"verified": "2026-10-01", "cased": "yes"},
            sorted(set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,’“”()-0123456789 ".strip())),
        ),
        "style/punctuation": ({"verified": "2026-10-01", "abbreviations": "etc"}, [". = none|space", ", = none|space"]),
        "style/conventions": ({"verified": "2026-10-01"}, ["Law = Law", "numbers 1-10 = digits"]),
        "glossary/wordlist-approved": ({"verified": "2026-10-01"}, sorted(latin_baseline().approved_words)),
    }
    lists.update(overrides.pop("lists", {}))
    data = [
        {
            "path": f"decisions/{baseline_slug(path)}.md",
            "kind": "decision",
            "status": "approved",
            "content": render_block(headers, items),
        }
        for path, (headers, items) in lists.items()
    ]
    return {"brief": {"content": "QA OPERATING RULES"}, "data": data, **overrides}


def dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)
