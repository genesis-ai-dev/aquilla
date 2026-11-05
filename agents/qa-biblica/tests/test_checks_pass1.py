"""Pass 1 checkers against fixture corpora, in three scripts.

Each test plants exactly one fault and asserts the check names it, at the
severity its skill file assigns. The clean-corpus tests are the ones that matter
most: a QA pass that reports noise on correct text is worse than no pass.
"""

from __future__ import annotations

import unittest

from qa_biblica.checks import capitalization_numbers, chapter_verse, characters_punctuation, text_integrity
from qa_biblica.findings import Confidence, Severity

from . import fixtures as fx


def checks(result, name: str):
    return [f for f in result.findings if f.check == name]


class ChapterVerseTest(unittest.TestCase):
    def test_clean_corpus_is_silent(self):
        result = chapter_verse.run(fx.latin_clean())
        self.assertEqual([], result.findings, msg=fx.dump([f.check for f in result.findings]))

    def test_missing_verse_is_critical(self):
        corpus = fx.corpus(
            fx.verse("MRK 1:1", "The beginning of the gospel.", "The beginning of the gospel."),
            fx.verse("MRK 1:2", "As it is written in Isaiah.", ""),
        )
        found = checks(chapter_verse.run(corpus), "Missing verse")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.CRITICAL, found[0].severity)
        self.assertEqual(Confidence.HIGH, found[0].confidence)
        self.assertEqual(("MRK 1:2",), found[0].refs)

    def test_duplicate_reference_is_critical(self):
        corpus = fx.corpus(
            fx.verse("MRK 1:1", "a", "one", cell_id="c1"),
            fx.verse("MRK 1:1", "a", "one again", cell_id="c2"),
        )
        found = checks(chapter_verse.run(corpus), "Duplicate verse")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.CRITICAL, found[0].severity)

    def test_duplicated_text_in_one_chapter_is_major(self):
        line = "He went out again beside the sea and taught them."
        corpus = fx.corpus(
            fx.verse("MRK 2:13", "He went out again beside the sea.", line),
            fx.verse("MRK 2:14", "And as he passed on he saw Levi.", line),
        )
        found = checks(chapter_verse.run(corpus), "Duplicated text")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)

    def test_verse_number_typed_in_the_text(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "For God so loved", "16 For God so loved"))
        found = checks(chapter_verse.run(corpus), "Verse number typed in the text")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)

    def test_textual_variant_mismatch_follows_the_source(self):
        """The source omits MRK 9:44; a target that has it is a Major mismatch."""
        corpus = fx.corpus(fx.verse("MRK 9:44", "", "where the worm does not die"))
        found = checks(chapter_verse.run(corpus), "Textual-variant mismatch with the source")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)

    def test_textual_variant_present_in_both_is_silent(self):
        corpus = fx.corpus(fx.verse("MRK 9:44", "where the worm does not die", "where the worm does not die"))
        self.assertEqual([], checks(chapter_verse.run(corpus), "Textual-variant mismatch with the source"))

    def test_merged_verses_names_both_cells(self):
        long_text = "A " * 80
        corpus = fx.corpus(
            fx.verse("MRK 3:1", "He entered again.", "He entered again."),
            fx.verse("MRK 3:2", "They watched him.", long_text),
            fx.verse("MRK 3:3", "And he said to the man.", ""),
            fx.verse("MRK 3:4", "And he said to them.", "And he said to them."),
        )
        found = checks(chapter_verse.run(corpus), "Merged verses")
        self.assertEqual(1, len(found))
        self.assertEqual(("MRK 3:2", "MRK 3:3"), found[0].refs)


class TextIntegrityTest(unittest.TestCase):
    def test_clean_corpus_is_silent(self):
        baseline = fx.latin_baseline()
        result = text_integrity.run(fx.latin_clean(), approved_characters=baseline.characters)
        self.assertEqual([], result.findings, msg=fx.dump([f.check for f in result.findings]))

    def test_stray_html_tag_is_critical(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "For God so loved", "For <i>God</i> so loved"))
        result = text_integrity.run(corpus, approved_characters=fx.latin_baseline().characters)
        found = [f for f in result.findings if "HTML/XML tag" in f.check]
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.CRITICAL, found[0].severity)
        self.assertEqual(Confidence.HIGH, found[0].confidence)

    def test_backslash_code_is_critical(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "For God so loved", "\\v 16 For God so loved"))
        result = text_integrity.run(corpus, approved_characters=fx.latin_baseline().characters)
        self.assertTrue([f for f in result.findings if "Backslash code" in f.check])

    def test_drafting_note_is_critical(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "For God so loved", "For God so loved TODO"))
        found = checks(
            text_integrity.run(corpus, approved_characters=fx.latin_baseline().characters),
            "Drafting note left in the text",
        )
        self.assertEqual(Severity.CRITICAL, found[0].severity)

    def test_placeholder_cell_is_critical(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "For God so loved the world.", "-"))
        found = checks(
            text_integrity.run(corpus, approved_characters=fx.latin_baseline().characters),
            "Placeholder cell",
        )
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.CRITICAL, found[0].severity)

    def test_mojibake_is_critical(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "For God so loved", "For God so loved�"))
        found = checks(
            text_integrity.run(corpus, approved_characters=fx.latin_baseline().characters),
            "Corrupted characters",
        )
        self.assertEqual(Severity.CRITICAL, found[0].severity)

    def test_leftover_source_run_is_major(self):
        source = "And he said to them, Follow me and I will make you fishers of men."
        target = "Et il leur dit, Follow me and I will make you pêcheurs d hommes."
        corpus = fx.corpus(fx.verse("MRK 1:17", source, target))
        found = checks(
            text_integrity.run(corpus, approved_characters=fx.latin_baseline().characters),
            "Leftover source text",
        )
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)

    def test_non_nfc_text_is_minor(self):
        decomposed = "café"  # e + combining acute
        corpus = fx.corpus(fx.verse("JHN 3:16", "cafe", decomposed, target_raw=decomposed))
        corpus.verses[0].target = "café"
        found = checks(
            text_integrity.run(corpus, approved_characters=fx.latin_baseline().characters | {"é"}),
            "Not NFC-normalized",
        )
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MINOR, found[0].severity)


class CharactersPunctuationTest(unittest.TestCase):
    def test_refuses_to_run_without_a_baseline(self):
        from qa_biblica.baseline import Baseline

        result = characters_punctuation.run(fx.latin_clean(), Baseline())
        self.assertEqual([], result.findings)
        self.assertTrue(any("qa-bootstrap-inventories" in n for n in result.not_checked))

    def test_clean_corpus_is_silent(self):
        result = characters_punctuation.run(fx.latin_clean(), fx.latin_baseline())
        self.assertEqual([], result.findings, msg=fx.dump([f.found for f in result.findings]))

    def test_wrong_code_point_is_major_with_an_autofix(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "God's love", "God's love"))
        found = checks(characters_punctuation.run(corpus, fx.latin_baseline()), "Wrong code point")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)
        self.assertIn("autofix", found[0].proposed_fix)

    def test_wrong_script_character_is_critical(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "world", "wоrld"))  # Cyrillic о
        result = characters_punctuation.run(corpus, fx.latin_baseline())
        self.assertTrue(
            [f for f in result.findings if f.severity is Severity.CRITICAL],
            msg=fx.dump([(f.check, f.severity.value) for f in result.findings]),
        )

    def test_mixed_script_word_is_critical(self):
        corpus = fx.corpus(fx.verse("JHN 3:16", "world", "wоrld"))
        found = checks(characters_punctuation.run(corpus, fx.latin_baseline()), "Mixed-script word")
        self.assertEqual(Severity.CRITICAL, found[0].severity)

    def test_unpaired_quote_is_major(self):
        corpus = fx.corpus(
            fx.verse("MRK 1:1", "He said, Come.", "He said, “Come."),
            fx.verse("MRK 1:2", "And they came.", "And they came."),
        )
        found = checks(characters_punctuation.run(corpus, fx.latin_baseline()), "Unmatched pair")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)

    def test_closed_quote_across_cells_is_silent(self):
        corpus = fx.corpus(
            fx.verse("MRK 1:1", "He said, Come.", "He said, “Come."),
            fx.verse("MRK 1:2", "And follow me.", "and follow me.”"),
        )
        self.assertEqual([], checks(characters_punctuation.run(corpus, fx.latin_baseline()), "Unmatched pair"))

    def test_arabic_corpus_is_silent_on_its_own_baseline(self):
        result = characters_punctuation.run(fx.arabic_clean(), fx.arabic_baseline())
        self.assertEqual([], result.findings, msg=fx.dump([f.found for f in result.findings]))


class CapitalizationNumbersTest(unittest.TestCase):
    def test_clean_corpus_is_silent(self):
        result = capitalization_numbers.run(fx.latin_clean(), fx.latin_baseline())
        self.assertEqual([], result.findings, msg=fx.dump([f.found for f in result.findings]))

    def test_number_mismatch_is_major(self):
        corpus = fx.corpus(fx.verse("MRK 6:44", "There were five thousand men, 5000.", "There were 4000."))
        found = checks(capitalization_numbers.run(corpus, fx.latin_baseline()), "Number mismatch")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)
        self.assertEqual(Confidence.HIGH, found[0].confidence)

    def test_digits_match_across_scripts(self):
        """40 = ٤٠: the same number in two scripts is not a mismatch."""
        corpus = fx.corpus(fx.verse("MRK 1:13", "forty days, 40.", "٤٠ يوم"))
        self.assertEqual(
            [], checks(capitalization_numbers.run(corpus, fx.arabic_baseline()), "Number mismatch")
        )

    def test_capitalization_is_skipped_on_a_caseless_script(self):
        result = capitalization_numbers.run(fx.arabic_clean(), fx.arabic_baseline())
        self.assertTrue(any("no upper/lower case" in n for n in result.not_checked))

    def test_recurring_word_in_the_wrong_case_is_major(self):
        baseline = fx.latin_baseline()
        baseline.conventions = {"law": "Law"}
        corpus = fx.corpus(fx.verse("ROM 3:20", "by the law", "by the law"))
        found = checks(
            capitalization_numbers.run(corpus, baseline), "Recurring word in the non-approved case"
        )
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MAJOR, found[0].severity)

    def test_repeated_word_not_in_the_source_is_minor(self):
        corpus = fx.corpus(fx.verse("MRK 1:1", "The beginning of the gospel.", "The the beginning."))
        found = checks(capitalization_numbers.run(corpus, fx.latin_baseline()), "Repeated word")
        self.assertEqual(1, len(found))
        self.assertEqual(Severity.MINOR, found[0].severity)

    def test_repetition_present_in_the_source_is_dropped(self):
        corpus = fx.corpus(fx.verse("ACT 9:4", "Saul, Saul, why do you persecute me?", "Saul, Saul, pourquoi?"))
        self.assertEqual([], checks(capitalization_numbers.run(corpus, fx.latin_baseline()), "Repeated word"))

    def test_mixed_digit_scripts_in_one_number_is_major(self):
        corpus = fx.corpus(fx.verse("MRK 1:13", "40 days, 40.", "4٠ days, 40."))
        found = checks(
            capitalization_numbers.run(corpus, fx.latin_baseline()), "Mixed digit scripts in one number"
        )
        self.assertEqual(Severity.MAJOR, found[0].severity)


if __name__ == "__main__":
    unittest.main()
