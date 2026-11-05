import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "examples" / "tiny-ml-eval"
sys.path.insert(0, str(EVAL))

import torch
from common import configure_cpu, dataset, load_config, write_json
from evaluate import evaluate
from judge import judge
from train import train


class TinyTaskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        configure_cpu()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="axiom-tiny-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.candidate = self.root / "input"
        shutil.copytree(ROOT / "examples" / "tiny-ml-task", self.candidate)
        self.run = self.root / "run"

    def test_splits_are_deterministic_balanced_and_distinct(self):
        all_rows = []
        for split in ("train", "validation", "final-test"):
            x, y = dataset(split)
            xx, yy = dataset(split)
            self.assertTrue(torch.equal(x, xx) and torch.equal(y, yy))
            self.assertEqual(int(y.sum()), len(y) // 2)
            all_rows.append({tuple(row) for row in x.tolist()})
        for i in range(3):
            for j in range(i):
                self.assertTrue(all_rows[i].isdisjoint(all_rows[j]))

    def test_config_rejects_extra_fields_invalid_types_and_ranges(self):
        original = load_config(self.candidate)
        for key, value in [("epochs", True), ("epochs", 0), ("epochs", 121), ("seed", -1), ("learning_rate", float("nan")), ("learning_rate", 9), ("hidden_test", True)]:
            config = {**original, key: value}
            (self.candidate / "config.json").write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_config(self.candidate)

    def test_full_baseline_and_reference_are_reproducible_and_improvable(self):
        baseline = train(self.candidate, self.run)
        score = evaluate(self.run)
        self.assertEqual(baseline["epochs_executed"], 80)
        self.assertLess(score["accuracy"], 0.75)
        reference_run = self.root / "reference"
        train(ROOT / "tests" / "fixtures" / "tiny-ml-reference", reference_run)
        improved = evaluate(reference_run)
        self.assertGreater(improved["accuracy"], 0.90)
        self.assertGreater(improved["accuracy"], score["accuracy"] + 0.20)
        second = self.root / "second"
        train(ROOT / "tests" / "fixtures" / "tiny-ml-reference", second)
        self.assertEqual(evaluate(second)["accuracy"], improved["accuracy"])
        self.assertEqual(evaluate(second)["loss"], improved["loss"])
        self.assertEqual(judge(self.run)["metric_status"], "best_effort")
        judged = judge(reference_run)
        self.assertEqual(judged["metric_status"], "target_met")
        self.assertEqual(judged["compliance_status"], "not_fully_verified")

    def test_smoke_executes_two_steps_and_cannot_claim_formal_score(self):
        metadata = train(self.candidate, self.run, "smoke")
        self.assertEqual(metadata["epochs_executed"], 2)
        self.assertEqual(metadata["train_samples"], 16)
        self.assertEqual(evaluate(self.run)["level"], "smoke")
        with self.assertRaisesRegex(ValueError, "formal"):
            evaluate(self.run, "final-test")

    def test_proxy_does_not_equal_full(self):
        metadata = train(self.candidate, self.run, "proxy")
        self.assertEqual(metadata["epochs_executed"], 20)
        self.assertEqual(metadata["train_samples"], 256)
        with self.assertRaisesRegex(ValueError, "formal"):
            evaluate(self.run, "final-test")

    def test_evaluator_ignores_reported_metrics_and_original_source_changes(self):
        train(self.candidate, self.run, "smoke")
        before = evaluate(self.run)
        write_json(self.run / "metrics.json", {"accuracy": 1.0})
        (self.candidate / "model.py").write_text("raise RuntimeError('changed original')", encoding="utf-8")
        after = evaluate(self.run)
        self.assertEqual(before["accuracy"], after["accuracy"])
        self.assertEqual(before["loss"], after["loss"])

    def test_tampered_snapshot_is_rejected(self):
        train(self.candidate, self.run, "smoke")
        with (self.run / "candidate" / "model.py").open("a", encoding="utf-8") as f:
            f.write("\n# changed\n")
        with self.assertRaisesRegex(ValueError, "snapshot hash"):
            evaluate(self.run)

    def test_tampered_checkpoint_is_rejected_before_loading(self):
        train(self.candidate, self.run, "smoke")
        (self.run / "checkpoint.pt").write_bytes(b"broken")
        with self.assertRaisesRegex(ValueError, "Checkpoint hash"):
            evaluate(self.run)

    def test_changed_evaluator_identity_is_rejected(self):
        train(self.candidate, self.run, "smoke")
        path = self.run / "run.json"
        metadata = json.loads(path.read_text(encoding="utf-8"))
        metadata["evaluator_sha256"]["evaluate.py"] = "0" * 64
        path.write_text(json.dumps(metadata), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "evaluator/trainer changed"):
            evaluate(self.run)

    def test_relabelled_smoke_as_full_is_rejected(self):
        train(self.candidate, self.run, "smoke")
        path = self.run / "run.json"
        metadata = json.loads(path.read_text(encoding="utf-8"))
        metadata["level"] = "full"
        path.write_text(json.dumps(metadata), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "scope"):
            evaluate(self.run, "final-test")

    def test_output_is_never_overwritten(self):
        train(self.candidate, self.run, "smoke")
        before = (self.run / "run.json").read_bytes()
        with self.assertRaises(FileExistsError):
            train(self.candidate, self.run, "smoke")
        self.assertEqual(before, (self.run / "run.json").read_bytes())
        with self.assertRaises(FileExistsError):
            write_json(self.run / "run.json", {})

    def test_invalid_shape_is_rejected(self):
        (self.candidate / "model.py").write_text("from torch import nn\ndef build_model(): return nn.Linear(2, 3)\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "logits"):
            train(self.candidate, self.run, "smoke")

    def test_checkpoint_load_and_evaluation_in_fresh_process(self):
        train(self.candidate, self.run)
        command = [sys.executable, str(EVAL / "evaluate.py"), "--run", str(self.run), "--split", "final-test"]
        process = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        self.assertEqual(result["scope"], "formal tiny-task evaluation")
        self.assertEqual(result["samples"], 512)


if __name__ == "__main__":
    unittest.main()
