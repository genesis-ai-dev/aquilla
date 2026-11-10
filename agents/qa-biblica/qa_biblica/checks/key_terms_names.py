"""Pass 3 — `skills/qa-key-terms-names.md`. Key terms and proper names.

The pass is built around one API read: `GET …/terms/consistency` already runs
the same scan the in-app "Check file" pass runs, and reports per concept how
many occurrences used an approved rendering, which cells used which rendering,
and which used none (`sync-worker/src/external/quality-routes.ts`).

So this module's job is **not** to re-implement that scan. It is to:

* report what `terms/consistency` found as the skill file groups it — split
  usage, collisions, missing renderings;
* stay silent on what the scan already marks as approved usage, which is the
  skill's "Baseline first" rule and an explicit acceptance criterion;
* add the two things the scan does not do — collisions across concepts, and name
  spelling clusters;
* flag the doctrinal guardrails without deciding them.
"""

from __future__ import annotations

from collections import defaultdict

from ..corpus import Corpus, Verse, tokenize
from ..findings import Confidence, Finding, FindingSet, Severity, Verifier
from .spelling_wordlist import edit_distance

SKILL = "qa-key-terms-names"
_VERIFIER = Verifier.MENTOR

#: qa-key-terms-names.md → 6. Each entry is (concept marker, what must not be read).
#: Flagged, never decided: a hit is a Query carrying evidence for the mentor.
DOCTRINAL_GUARDRAILS: tuple[tuple[str, str], ...] = (
    ("Son of God", "must not read as physical offspring"),
    ("Holy Spirit", "must not read as 'ghost' in a misleading sense"),
    ("justification", "must not become 'obedience' or 'works'"),
    ("faith", "must not become 'obedience' or 'works'"),
    ("kingdom of God", "must not read as an earthly government"),
)

#: Name variants cluster at this distance (skill file: ≤ 2, same first letter).
NAME_DISTANCE = 2


def run(
    corpus: Corpus,
    *,
    terms: list[dict],
    consistency: dict,
    violations: set[str] | None = None,
) -> FindingSet:
    """`terms` from `GET …/terms`, `consistency` from `GET …/terms/consistency`.

    `violations` holds check names Aquilla's own Violations inbox already
    reports for the scope; a concept it covers is cited by check name rather
    than re-reported (qa-run-book.md → Procedure 2).
    """
    out = FindingSet(SKILL)
    already_reported = violations or set()
    by_id = {t.get("conceptId"): t for t in terms}
    active = [t for t in terms if t.get("status") == "active"]
    findings = consistency.get("data") or []

    out.log(
        f"termbase: {len(terms)} concepts ({len(active)} active); "
        f"consistency scan covered {consistency.get('scannedCells', 0)} cells, "
        f"{consistency.get('flaggedCellCount', 0)} flagged occurrence(s)"
    )
    if consistency.get("truncated"):
        out.skip(
            "Term consistency",
            "the consistency scan hit its cell cap, so the counts below cover only part of "
            "the scope — re-run per book with fileId= to get complete numbers.",
        )

    cells_by_id = {v.cell_id: v for v in corpus}
    rendering_owners: dict[str, list[str]] = defaultdict(list)

    for finding in findings:
        concept_id = finding.get("conceptId")
        source_term = finding.get("sourceTerm") or str(concept_id)
        usage = [u for u in (finding.get("renderingUsage") or []) if u.get("cellIds")]
        for entry in usage:
            rendering_owners[str(entry.get("rendering"))].append(source_term)

        # "Baseline first": a concept whose every occurrence used an approved
        # rendering is silent. That is the acceptance criterion about not
        # re-reporting what terms/consistency already marks as approved usage.
        flagged = finding.get("flaggedCells") or []
        if not flagged and len(usage) <= 1:
            continue

        if len(usage) > 1:
            _split_usage(out, source_term, usage, cells_by_id, finding)
        if flagged:
            _missing_rendering(out, source_term, flagged, cells_by_id, finding, already_reported)
        _forbidden_renderings(out, source_term, by_id.get(concept_id), corpus)

    _collisions(out, rendering_owners)
    _names(out, corpus, terms)
    _doctrinal(out, corpus)
    return out


def _split_usage(out: FindingSet, source_term: str, usage, cells_by_id, finding: dict) -> None:
    spread = "; ".join(
        f"{entry.get('rendering')!r} ×{len(entry.get('cellIds') or [])}" for entry in usage
    )
    refs, cell_ids = _refs(
        [cid for entry in usage for cid in (entry.get("cellIds") or [])], cells_by_id
    )
    out.add(
        Finding(
            skill=SKILL,
            check="Split usage",
            severity=Severity.MAJOR,
            confidence=Confidence.HIGH,
            refs=refs,
            cell_ids=cell_ids,
            file_id=_file_of(cell_ids, cells_by_id),
            found=f"{source_term!r} is rendered {len(usage)} ways: {spread}",
            evidence=(
                f"GET terms/consistency: {finding.get('consistentCount')} of "
                f"{finding.get('totalOccurrences')} occurrences used an approved rendering "
                f"({finding.get('consistencyPercent')}%)"
            ),
            proposed_fix=(
                "the mentor decides whether the variation is justified by context "
                "(kingdom of God vs kingdom of heaven are both valid and must not be merged)"
            ),
            verifier=_VERIFIER,
        )
    )


def _missing_rendering(
    out: FindingSet, source_term: str, flagged, cells_by_id, finding: dict, already: set[str]
) -> None:
    if "Term consistency" in already:
        out.log(
            f"{source_term}: {len(flagged)} missing-rendering occurrence(s) left to Aquilla's "
            "Term consistency check, already in the Violations inbox"
        )
        return
    refs, cell_ids = _refs([c.get("cellId") for c in flagged], cells_by_id)
    out.add(
        Finding(
            skill=SKILL,
            check="Missing rendering",
            severity=Severity.QUERY,
            confidence=Confidence.MEDIUM,
            refs=refs,
            cell_ids=cell_ids,
            file_id=_file_of(cell_ids, cells_by_id),
            found=f"{len(flagged)} occurrence(s) of {source_term!r} where no known rendering appears",
            evidence="GET terms/consistency flaggedCells",
            proposed_fix=(
                "may be deliberate — a pronoun or a restructured clause. The mentor confirms, "
                "or the post-editor adds the rendering"
            ),
            verifier=_VERIFIER,
        )
    )


def _forbidden_renderings(out: FindingSet, source_term: str, concept: dict | None, corpus: Corpus) -> None:
    if not concept:
        return
    forbidden = [
        str(r.get("rendering"))
        for r in (concept.get("renderings") or [])
        if r.get("status") == "forbidden" and r.get("rendering")
    ]
    if not forbidden:
        return
    for rendering in forbidden:
        hits = [v for v in corpus if v.has_target and rendering in v.target]
        if not hits:
            continue
        out.add(
            Finding(
                skill=SKILL,
                check="Forbidden rendering present",
                severity=Severity.MAJOR,
                confidence=Confidence.HIGH,
                refs=tuple(v.ref_label for v in hits[:5]),
                cell_ids=tuple(v.cell_id for v in hits[:5]),
                file_id=hits[0].file_id,
                found=f"{rendering!r} is marked forbidden for {source_term!r} and appears {len(hits)}×",
                evidence="termbase rendering status; Aquilla also flags this in the Violations inbox",
                proposed_fix="replace with the required rendering",
                verifier=_VERIFIER,
            )
        )


def _collisions(out: FindingSet, rendering_owners: dict[str, list[str]]) -> None:
    """One target word used for two distinct key terms."""
    for rendering, concepts in rendering_owners.items():
        distinct = sorted(set(concepts))
        if len(distinct) < 2:
            continue
        out.add(
            Finding(
                skill=SKILL,
                check="Collision",
                severity=Severity.MAJOR,
                confidence=Confidence.HIGH,
                found=f"{rendering!r} is the rendering used for {len(distinct)} concepts: {', '.join(distinct)}",
                evidence="derived from terms/consistency renderingUsage across concepts",
                proposed_fix="the mentor decides whether the concepts may share a word",
                verifier=_VERIFIER,
            )
        )


def _names(out: FindingSet, corpus: Corpus, terms: list[dict]) -> None:
    """Cluster spelling variants of each termbase name (distance ≤ 2, same initial)."""
    recorded = {
        str(r.get("rendering"))
        for t in terms
        for r in (t.get("renderings") or [])
        if r.get("rendering")
    }
    if not recorded:
        return
    seen: dict[str, dict[str, list[Verse]]] = defaultdict(lambda: defaultdict(list))
    for verse in corpus:
        if not verse.has_target:
            continue
        for word in tokenize(verse.target):
            for name in recorded:
                if word == name:
                    seen[name][word].append(verse)
                elif (
                    word[:1] == name[:1]
                    and len(word) > 3
                    and edit_distance(word, name, ceiling=NAME_DISTANCE) <= NAME_DISTANCE
                ):
                    seen[name][word].append(verse)
    for name, spellings in seen.items():
        if len(spellings) < 2:
            continue
        spread = "; ".join(f"{form} ×{len(v)}" for form, v in sorted(spellings.items()))
        verses = [v for group in spellings.values() for v in group][:5]
        out.add(
            Finding(
                skill=SKILL,
                check="Name with more than one spelling",
                severity=Severity.MAJOR,
                confidence=Confidence.HIGH,
                refs=tuple(v.ref_label for v in verses),
                cell_ids=tuple(v.cell_id for v in verses),
                file_id=verses[0].file_id if verses else "",
                found=f"{name!r} appears as {len(spellings)} spellings: {spread}",
                evidence=f"clustered at edit distance ≤ {NAME_DISTANCE} with the same first letter",
                proposed_fix="the mentor picks the spelling; then record it in glossary/names",
                verifier=_VERIFIER,
            )
        )


def _doctrinal(out: FindingSet, corpus: Corpus) -> None:
    """Flag, don't decide.

    The runner cannot read a back translation over the Agent API today (the
    issue files that as a follow-up), so the only honest version of this check
    is to point the mentor at the verses where a guardrail concept occurs in the
    **source**. It is a Query at Low confidence, which qa-run-book.md requires
    for any model-grade judgment in this language — and Low is always a Query.
    """
    for marker, rule in DOCTRINAL_GUARDRAILS:
        hits = [v for v in corpus if v.has_target and marker.lower() in v.source.lower()]
        if not hits:
            continue
        out.add(
            Finding(
                skill=SKILL,
                check="Doctrinal guardrail",
                severity=Severity.QUERY,
                confidence=Confidence.LOW,
                refs=tuple(v.ref_label for v in hits[:5]),
                cell_ids=tuple(v.cell_id for v in hits[:5]),
                file_id=hits[0].file_id,
                found=f"{marker!r} occurs in the source at {len(hits)} verse(s); {rule}",
                evidence=(
                    "source-side occurrence only — the Agent API has no back-translation read, "
                    "so the rendering itself was not assessed"
                ),
                proposed_fix="the mentor reads the rendering and decides whether to involve a consultant",
                verifier=_VERIFIER,
            )
        )


def _refs(cell_ids, cells_by_id) -> tuple[tuple[str, ...], tuple[str, ...]]:
    refs: list[str] = []
    ids: list[str] = []
    for cell_id in cell_ids:
        verse = cells_by_id.get(cell_id)
        if verse is None or verse.ref_label in refs:
            continue
        refs.append(verse.ref_label)
        ids.append(cell_id)
        if len(refs) >= 5:
            break
    return tuple(refs), tuple(ids)


def _file_of(cell_ids, cells_by_id) -> str:
    for cell_id in cell_ids:
        verse = cells_by_id.get(cell_id)
        if verse is not None:
            return verse.file_id
    return ""
