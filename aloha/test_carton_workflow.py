#!/usr/bin/env python3
"""Smoke test of carton_workflow.py against the live Roboflow workflow: python3 aloha/test_carton_workflow.py

On samples/carton_open.jpg (640 x 480, an open carton with a bottle and a warning-taped box in it) it checks the
workflow's answer has the outputs carton_workflow.py reads and not the ones it leaves out, and what it makes of them;
on a picture without a carton, that nothing is looked for; with a wrong key, that it fails at once. Needs the network
and ROBOFLOW_API_KEY (exported, or in the package root's .env): without the key only the offline test runs."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import carton_workflow  # noqa: E402

SAMPLE = HERE / "samples" / "carton_open.jpg"
NO_CARTON = HERE.parent / "assets" / "plots" / "waypoint_reach_rate.png"


def has_key():
    try:
        carton_workflow.api_key()
        return True
    except carton_workflow.MissingKeyError:
        return False


class Offline(unittest.TestCase):
    def test_no_key(self):
        with mock.patch.dict("os.environ", {carton_workflow.KEY_VAR: ""}), \
                mock.patch.object(carton_workflow, "ENV_FILE", HERE / "no such .env"):
            with self.assertRaises(carton_workflow.MissingKeyError):
                carton_workflow.run_carton_workflow([SAMPLE], HERE)


@unittest.skipUnless(has_key(), f"no {carton_workflow.KEY_VAR}")
class Live(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.out = Path(tmp.name)

    def run_spied(self, photos):
        """run_carton_workflow's results, and the workflow's raw outputs per photo"""
        answers, post = [], carton_workflow._post

        def spy(*args, **kwargs):
            answers.append(post(*args, **kwargs))
            return answers[-1]

        with mock.patch.object(carton_workflow, "_post", spy):
            results = carton_workflow.run_carton_workflow(photos, self.out)
        return results, answers[0]

    def test_sample_photo(self):
        results, [outputs] = self.run_spied([SAMPLE])
        for name in carton_workflow.OUTPUTS:
            self.assertIn(name, outputs)
        for name in carton_workflow.EXCLUDED:
            self.assertNotIn(name, outputs)
        [result] = results
        self.assertTrue(result.interior)
        self.assertTrue(result.objects, "nothing found in the sample, which has a bottle and a warning-taped box")
        for found in result.objects:
            self.assertIsInstance(found.name, str)
            self.assertTrue(0.0 <= found.confidence <= 1.0)
        self.assertEqual([f.confidence for f in result.objects],
                         sorted((f.confidence for f in result.objects), reverse=True))
        self.assertEqual(result.image, self.out / "carton_open_annotated.jpg")
        self.assertEqual(result.image.read_bytes()[:3], b"\xff\xd8\xff")  # a JPEG

    def test_no_carton(self):
        [result] = carton_workflow.run_carton_workflow([NO_CARTON], self.out)
        self.assertEqual(result, carton_workflow.PhotoResult(False, [], None))

    def test_wrong_key(self):
        with mock.patch.dict("os.environ", {carton_workflow.KEY_VAR: "not-a-key"}), \
                mock.patch.object(carton_workflow.time, "sleep") as sleep:
            with self.assertRaises(carton_workflow.WorkflowRequestError) as raised:
                carton_workflow.run_carton_workflow([SAMPLE], self.out)
        self.assertIn(raised.exception.status, (401, 403))
        self.assertNotIn("not-a-key", str(raised.exception))
        sleep.assert_not_called()  # refused: no retries


if __name__ == "__main__":
    unittest.main(verbosity=2)
