import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "examples" / "tiny-ml-eval"
sys.path.insert(0, str(EVAL))
import common
from train import train
from validate_only import validate


class ValidationOnlyTests(unittest.TestCase):
    def test_entrypoint_only_generates_validation_data_and_reloads_actual_model(self):
        with tempfile.TemporaryDirectory(prefix="axiom-validation-") as directory:
            run = Path(directory) / "run"
            train(ROOT / "examples" / "tiny-ml-task", run)
            original = common.dataset
            accessed = []

            def spy(split):
                accessed.append(split)
                if split != "validation":
                    raise AssertionError("Final test or training data must not enter independent validation")
                return original(split)

            with patch.object(common, "dataset", spy):
                result = validate(run)
            self.assertEqual(accessed, ["validation"])
            self.assertEqual(result["dataset_access_log"], ["validation"])
            self.assertEqual(result["level"], "full")
            self.assertEqual(result["accuracy"], 0.5)
            self.assertEqual(len(result["evaluation_entrypoint_sha256"]), 64)

    def test_cli_cannot_select_final_test_split(self):
        process = subprocess.run(
            [sys.executable, str(EVAL / "validate_only.py"), "--run", "nonexistent", "--split", "final-test"],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(process.returncode, 2)
        self.assertIn("unrecognized arguments", process.stderr)
        self.assertEqual(process.stdout, "")


if __name__ == "__main__":
    unittest.main()
