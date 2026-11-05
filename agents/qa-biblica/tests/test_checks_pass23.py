"""Pass 2 (spelling) and Pass 3 (key terms and names)."""

from __future__ import annotations

import unittest

from qa_biblica.baseline import Baseline
from qa_biblica.checks import key_terms_names, spelling_wordlist
from qa_biblica.findings import Confidence, Severity, Verifier

from . import fixtures as fx


def checks(result, name: str):
    findings = result.findings.findings if hasattr(result, "findings") and hasattr(result.findings, "findings") else result.findings
    return [f for f in findings if f.check == name]


class SpellingTest(unittest.TestCase):
    def test_refuses_to_run_without_a_wordlist(self):
        result = spelling_wordlist.run(fx.latin_clean(), Baseline())
        self.assertEqual([], result.findings.findings)
        self.assertTrue(any("qa-bootstrap-inventories" in n for n in result.findings.not_checked))

    def test_approved_words_are_silent(self):
        result = spelling_wordlist.run(fx.latin_clean(), fx.latin_baseline())
        self.assertEqual(
            [], result.findings.findings, msg=fx.dump([f.found for f in result.findings.findings])
        )

    def test_known_incorrect_word_is_major_with_the_approved_spelling(self):
        corpus = fx.corpus(fx.verse("JHN 3:18", "Whoever believes", "Whoever beleives"))
        found = checks(spelling_wordlist.run(corpus, fx.latin_baseline()), "Known-incorrect spelling")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)
        self.assertIn("believes", found[0].proposed_fix)

    def test_variant_within_one_edit_is_major(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "the world", "the worldd"))
        found = checks(spelling_wordlist.run(corpus, fx.latin_baseline()), "Spelling variant")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)
        self.assertIn("world", found[0].evidence)

    def test_new_word_is_a_query_and_lands_in_the_csv_list(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "the world", "the zzqxwv"))
        result = spelling_wordlist.run(corpus, fx.latin_baseline())
        found = checks(result, "New word")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.QUERY, found[0].severity)
        self.assertEqual([("zzqxwv", 1)], [(n.word, n.count) for n in result.new_words])

    def test_new_words_are_sorted_by_count(self):
        corpus = fx.corpus(
            fx.verse("MRK 1:1", "a", "zzqxwv zzqxwv qqplmn"),
            fx.verse("MRK 1:2", "a", "zzqxwv"),
        )
        result = spelling_wordlist.run(corpus, fx.latin_baseline())
        self.assertEqual(["zzqxwv", "qqplmn"], [n.word for n in result.new_words])

    def test_verified_affixes_make_an_inflected_form_approved(self):
        baseline = fx.latin_baseline()
        baseline.suffixes = ("ed",)
        corpus = fx.corpus(fx.verse("JHN 3:16", "loved", "loveded"))
        self.assertEqual("approved", spelling_wordlist.classify("loveded", baseline))

    def test_joined_word_is_reported(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "the world", "theworld"))
        found = checks(spelling_wordlist.run(corpus, fx.latin_baseline()), "Joined/split word")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)

    def test_edit_distance_abandons_past_the_ceiling(self):
        self.assertEqual(3, spelling_wordlist.edit_distance("abc", "xyz", ceiling=5))
        self.assertEqual(2, spelling_wordlist.edit_distance("abc", "xyz", ceiling=1))

    def test_numbers_are_not_spelling_findings(self):
        """Numbers belong to qa-capitalization-numbers, which checks them against
        the source verse. Reporting them here too would flag every number in the
        book as an unapproved new word."""
        corpus = fx.corpus(fx.verse("MRK 6:44", "There were 5000 men.", "There were 4000 men."))
        result = spelling_wordlist.run(corpus, fx.latin_baseline())
        # The sentence's unapproved *words* are still reported; the number is not.
        self.assertEqual([], [n.word for n in result.new_words if n.word.isdigit()])
        self.assertNotIn(
            "4000", " ".join(f.found for f in checks(result, "New word"))
        )
        self.assertTrue(
            any("numeric tokens skipped" in line for line in result.findings.code_log)
        )

    def test_a_word_used_twice_in_one_cell_is_one_reference(self):
        corpus = fx.corpus(fx.verse("MRK 1:1", "the gospel", "zzqxwv and zzqxwv"))
        found = checks(spelling_wordlist.run(corpus, fx.latin_baseline()), "New word")
        self.assertEqual(("MRK 1:1",), found[0].refs)

    def test_the_count_still_counts_every_occurrence(self):
        corpus = fx.corpus(fx.verse("MRK 1:1", "the gospel", "zzqxwv and zzqxwv"))
        result = spelling_wordlist.run(corpus, fx.latin_baseline())
        self.assertEqual([("zzqxwv", 2)], [(n.word, n.count) for n in result.new_words])

    def test_arabic_wordlist_is_silent_on_its_own_baseline(self):
        result = spelling_wordlist.run(fx.arabic_clean(), fx.arabic_baseline())
        self.assertEqual(
            [], result.findings.findings, msg=fx.dump([f.found for f in result.findings.findings])
        )


# ---------------------------------------------------------------------------


def consistency(findings, **envelope):
    return {"data": findings, "scannedCells": 10, "flaggedCellCount": 0, **envelope}


class KeyTermsTest(unittest.TestCase):
    def setUp(self):
        self.corpus = fx.corpus(
            fx.verse("MRK 1:1", "the covenant of God", "the pact of God", cell_id="c1"),
            fx.verse("MRK 1:2", "the covenant again", "the treaty again", cell_id="c2"),
            fx.verse("MRK 1:3", "the covenant once more", "the pact once more", cell_id="c3"),
        )

    def test_approved_usage_is_not_re_reported(self):
        """The acceptance criterion: do not re-report what terms/consistency
        already marks as approved usage."""
        result = key_terms_names.run(
            self.corpus,
            terms=[{"conceptId": "k1", "sourceTerm": "covenant", "status": "active", "renderings": []}],
            consistency=consistency(
                [
                    {
                        "conceptId": "k1",
                        "sourceTerm": "covenant",
                        "approvedRenderings": ["pact"],
                        "totalOccurrences": 3,
                        "consistentCount": 3,
                        "consistencyPercent": 100,
                        "renderingUsage": [{"rendering": "pact", "cellIds": ["c1", "c2", "c3"]}],
                        "flaggedCells": [],
                    }
                ]
            ),
        )
        self.assertEqual([], result.findings, msg=fx.dump([f.check for f in result.findings]))

    def test_split_usage_reports_counts_and_refs(self):
        result = key_terms_names.run(
            self.corpus,
            terms=[{"conceptId": "k1", "sourceTerm": "covenant", "status": "active", "renderings": []}],
            consistency=consistency(
                [
                    {
                        "conceptId": "k1",
                        "sourceTerm": "covenant",
                        "approvedRenderings": ["pact", "treaty"],
                        "totalOccurrences": 3,
                        "consistentCount": 3,
                        "consistencyPercent": 100,
                        "renderingUsage": [
                            {"rendering": "pact", "cellIds": ["c1", "c3"]},
                            {"rendering": "treaty", "cellIds": ["c2"]},
                        ],
                        "flaggedCells": [],
                    }
                ]
            ),
        )
        found = checks(result, "Split usage")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)
        self.assertEqual(Verifier.MENTOR, found[0].verifier)
        self.assertIn("'pact' ×2", found[0].found)
        self.assertIn("'treaty' ×1", found[0].found)
        self.assertEqual(("MRK 1:1", "MRK 1:3", "MRK 1:2"), found[0].refs)

    def test_missing_rendering_is_a_query(self):
        result = key_terms_names.run(
            self.corpus,
            terms=[{"conceptId": "k1", "sourceTerm": "covenant", "status": "active", "renderings": []}],
            consistency=consistency(
                [
                    {
                        "conceptId": "k1",
                        "sourceTerm": "covenant",
                        "approvedRenderings": ["pact"],
                        "totalOccurrences": 3,
                        "consistentCount": 2,
                        "consistencyPercent": 67,
                        "renderingUsage": [{"rendering": "pact", "cellIds": ["c1", "c3"]}],
                        "flaggedCells": [{"cellId": "c2"}],
                    }
                ]
            ),
        )
        found = checks(result, "Missing rendering")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.QUERY, found[0].severity)
        self.assertEqual(("MRK 1:2",), found[0].refs)

    def test_collision_across_two_concepts_is_major(self):
        result = key_terms_names.run(
            self.corpus,
            terms=[],
            consistency=consistency(
                [
                    {
                        "conceptId": "k1", "sourceTerm": "spirit", "totalOccurrences": 2,
                        "consistentCount": 1, "consistencyPercent": 50,
                        "renderingUsage": [{"rendering": "soul", "cellIds": ["c1"]}],
                        "flaggedCells": [{"cellId": "c2"}],
                    },
                    {
                        "conceptId": "k2", "sourceTerm": "ghost", "totalOccurrences": 2,
                        "consistentCount": 1, "consistencyPercent": 50,
                        "renderingUsage": [{"rendering": "soul", "cellIds": ["c3"]}],
                        "flaggedCells": [{"cellId": "c2"}],
                    },
                ]
            ),
        )
        found = checks(result, "Collision")
        self.assertEqual(1, len(found))
        self.assertIn("ghost, spirit", found[0].found)

    def test_forbidden_rendering_present_is_major(self):
        result = key_terms_names.run(
            self.corpus,
            terms=[
                {
                    "conceptId": "k1",
                    "sourceTerm": "covenant",
                    "status": "active",
                    "renderings": [{"rendering": "treaty", "status": "forbidden"}],
                }
            ],
            consistency=consistency(
                [
                    {
                        "conceptId": "k1", "sourceTerm": "covenant", "totalOccurrences": 3,
                        "consistentCount": 2, "consistencyPercent": 67,
                        "renderingUsage": [{"rendering": "pact", "cellIds": ["c1", "c3"]}],
                        "flaggedCells": [{"cellId": "c2"}],
                    }
                ]
            ),
        )
        found = checks(result, "Forbidden rendering present")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)

    def test_doctrinal_guardrail_is_a_low_confidence_query(self):
        corpus = fx.corpus(fx.verse("MRK 1:1", "the Son of God", "le Fils de Dieu"))
        result = key_terms_names.run(corpus, terms=[], consistency=consistency([]))
        found = checks(result, "Doctrinal guardrail")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.QUERY, found[0].severity)
        self.assertEqual(Confidence.LOW, found[0].confidence)
        self.assertIn("no back-translation read", found[0].evidence)

    def test_truncated_consistency_scan_is_declared_not_checked(self):
        result = key_terms_names.run(
            fx.latin_clean(), terms=[], consistency=consistency([], truncated=True)
        )
        self.assertTrue(any("cell cap" in n for n in result.not_checked))

    def test_name_with_two_spellings_is_major(self):
        corpus = fx.corpus(
            fx.verse("MRK 1:1", "Abraham believed", "Abraham believed"),
            fx.verse("MRK 1:2", "Abraham again", "Abrahim again"),
        )
        result = key_terms_names.run(
            corpus,
            terms=[
                {
                    "conceptId": "n1",
                    "sourceTerm": "Abraham",
                    "status": "active",
                    "renderings": [{"rendering": "Abraham", "status": "preferred"}],
                }
            ],
            consistency=consistency([]),
        )
        found = checks(result, "Name with more than one spelling")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)
        self.assertIn("Abrahim", found[0].found)


if __name__ == "__main__":
    unittest.main()
