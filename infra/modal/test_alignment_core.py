import unittest
from pathlib import Path
from unittest.mock import Mock
from alignment_core import build_alignment_result
from alignment_model import run_alignment


class BuildAlignmentResultTests(unittest.TestCase):
    def test_real_model_numeric_types_produce_json_safe_results(self):
        import json
        import numpy as np

        result = build_alignment_result("Known", [{
            "word": "Known", "start": np.float64(1),
            "end": np.float64(2), "score": np.float32(0.7),
        }], 5)
        self.assertEqual(json.loads(json.dumps(result)), result)
        self.assertIs(type(result["segments"][0]["needsReview"]), bool)

    def test_reversed_word_times_never_create_a_reversed_segment(self):
        segment = build_alignment_result("First second", [
            {"word": "First", "start": 3, "end": 4, "score": 0.9},
            {"word": "second", "start": 1, "end": 2, "score": 0.9},
        ], 5)["segments"][0]
        self.assertTrue(segment["needsReview"])
        self.assertTrue(segment["start"] is None or
                        segment["start"] < segment["end"])

    def test_model_failure_cleans_up_source_media(self):
        paths = []

        def load_audio(path):
            paths.append(Path(path))
            return [0.0] * 16000

        with self.assertRaisesRegex(RuntimeError, "model failed"):
            run_alignment(
                b"original-media", "Known wording", object(), {},
                load_audio=load_audio,
                align_audio=Mock(side_effect=RuntimeError("model failed")),
            )
        self.assertFalse(paths[0].exists())

    def test_empty_script_or_audio_never_calls_model(self):
        align_audio = Mock()
        for script, samples in [("  \n\n ", [0.0]), ("Known", [])]:
            with self.subTest(script=script):
                with self.assertRaises(ValueError):
                    run_alignment(
                        b"original-media", script, object(), {},
                        load_audio=Mock(return_value=samples),
                        align_audio=align_audio,
                    )
        align_audio.assert_not_called()

    def test_model_boundary_aligns_known_wording_and_cleans_up_media(self):
        paths = []
        audio = [0.0] * 80000

        def load_audio(path):
            paths.append(Path(path))
            self.assertEqual(Path(path).read_bytes(), b"original-media")
            return audio

        align_audio = Mock(return_value={"word_segments": [
            {"word": "Hello", "start": 1, "end": 1.5, "score": 0.9},
            {"word": "world.", "start": 1.6, "end": 2, "score": 0.9},
            {"word": "Next", "start": 3, "end": 3.5, "score": 0.9},
            {"word": "paragraph.", "start": 3.6, "end": 4, "score": 0.9},
        ]})
        model, metadata = object(), {"language": "en"}
        result = run_alignment(b"original-media", "Hello world.\n\nNext paragraph.",
                               model, metadata, load_audio=load_audio,
                               align_audio=align_audio, device="cpu")
        self.assertEqual(align_audio.call_args.args[0], [{
            "start": 0, "end": 5, "text": "Hello world. Next paragraph.",
        }])
        self.assertIs(align_audio.call_args.args[1], model)
        self.assertIs(align_audio.call_args.args[3], audio)
        self.assertEqual(align_audio.call_args.kwargs["interpolate_method"], "ignore")
        self.assertFalse(align_audio.call_args.kwargs["return_char_alignments"])
        self.assertEqual([segment["text"] for segment in result["segments"]],
                         ["Hello world.", "Next paragraph."])
        self.assertFalse(paths[0].exists())

    def test_unknown_or_invalid_word_timings_require_review(self):
        for word in [
            {"word": "Known", "score": 0.9},
            {"word": "Known", "start": float("nan"), "end": 1, "score": 0.9},
            {"word": "Known", "start": 1, "end": 1, "score": 0.9},
            {"word": "Known", "start": 1, "end": 9, "score": 0.9},
        ]:
            with self.subTest(word=word):
                segment = build_alignment_result("Known", [word], 5)["segments"][0]
                self.assertIsNone(segment["start"])
                self.assertIsNone(segment["end"])
                self.assertTrue(segment["needsReview"])
                self.assertEqual(segment["confidence"], 0)

    def test_low_or_unknown_acoustic_scores_require_review(self):
        for score in [None, float("nan"), -1, 2, 0.4]:
            with self.subTest(score=score):
                segment = build_alignment_result("Known", [
                    {"word": "Known", "start": 1, "end": 2, "score": score},
                ], 5)["segments"][0]
                self.assertTrue(segment["needsReview"])
                self.assertEqual((segment["start"], segment["end"]), (1, 2))
                self.assertEqual(segment["confidence"], 0.4 if score == 0.4 else 0)

    def test_missing_words_do_not_shift_later_paragraphs(self):
        result = build_alignment_result(
            "Hello missing world.\n\nUnspoken.\n\nNext paragraph.",
            [
                {"word": "Hello", "start": 1, "end": 1.4, "score": 0.9},
                {"word": "world.", "start": 1.5, "end": 2, "score": 0.8},
                {"word": "Next", "start": 3, "end": 3.5, "score": 0.95},
                {"word": "paragraph.", "start": 3.6, "end": 4, "score": 0.85},
            ],
            5,
        )
        first, missing, last = result["segments"]
        self.assertEqual((first["start"], first["end"]), (1, 2))
        self.assertEqual(first["matchedWords"], 2)
        self.assertTrue(first["needsReview"])
        self.assertEqual(first["status"], "partial")
        self.assertIsNone(missing["start"])
        self.assertIsNone(missing["end"])
        self.assertEqual(missing["confidence"], 0)
        self.assertEqual(missing["status"], "unmatched")
        self.assertEqual((last["start"], last["end"]), (3, 4))

    def test_build_alignment_result(self):
        result = build_alignment_result(
            script="Hello world.\n\nNext paragraph.",
            aligned_words=[
                {"word": "Hello", "start": 1, "end": 1.4, "score": 0.9},
                {"word": "world.", "start": 1.5, "end": 2, "score": 0.8},
                {"word": "Next", "start": 3, "end": 3.5, "score": 0.95},
                {"word": "paragraph.", "start": 3.6, "end": 4, "score": 0.85},
            ],
            duration_seconds=5,
        )
        self.assertEqual(result["method"], "ctc-forced-alignment")
        self.assertEqual(len(result["segments"]), 2)
        first, second = result["segments"]
        self.assertEqual(first["text"], "Hello world.")
        self.assertEqual(first["start"], 1)
        self.assertEqual(first["end"], 2)
        self.assertAlmostEqual(first["confidence"], 0.85)
        self.assertEqual(first["matchedWords"], 2)
        self.assertEqual(first["totalWords"], 2)
        self.assertFalse(first["needsReview"])
        self.assertEqual(first["status"], "matched")
        self.assertEqual(second["text"], "Next paragraph.")
        self.assertEqual(second["start"], 3)
        self.assertEqual(second["end"], 4)
        self.assertAlmostEqual(second["confidence"], 0.9)


if __name__ == "__main__":
    unittest.main()
