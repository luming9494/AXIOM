from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples" / "tiny-ml-eval"))
from review_candidate import review_source


class CandidatePolicyTests(unittest.TestCase):
    def test_baseline_and_reference_are_allowed(self):
        baseline = (ROOT / "examples" / "tiny-ml-task" / "model.py").read_text(encoding="utf-8")
        reference = (ROOT / "tests" / "fixtures" / "tiny-ml-reference" / "model.py").read_text(encoding="utf-8")
        self.assertEqual(review_source(baseline)["kind"], "linear")
        self.assertEqual(review_source(reference)["kind"], "mlp")
        self.assertEqual(review_source(reference)["parameters"], 82)

    def test_other_imports_statements_calls_and_dynamic_expressions_are_rejected(self):
        cases = [
            'import os\nfrom torch import nn\ndef build_model(): return nn.Linear(2,2)',
            'from torch import nn\nopen("bad", "w").write("bad")\ndef build_model(): return nn.Linear(2,2)',
            'from torch import nn\ndef build_model():\n open("bad", "w")\n return nn.Linear(2,2)',
            'from torch import nn\ndef build_model(): return nn.Linear(2, __import__("os").getpid())',
            'from torch import nn\ndef build_model(x=print("bad")): return nn.Linear(2,2)',
            'from torch import nn\ndef build_model(): return nn.Linear(2,2).to("cuda")',
            'from torch import nn\ndef build_model(): return nn.Sequential(*[nn.Linear(2,2)])',
            'from torch import nn as other\ndef build_model(): return other.Linear(2,2)',
            'from torch import nn\n@print("bad")\ndef build_model(): return nn.Linear(2,2)',
        ]
        for source in cases:
            with self.subTest(source=source), self.assertRaises((ValueError, SyntaxError)):
                review_source(source)

    def test_wrong_shape_and_excessive_parameters_are_rejected(self):
        for body in ['nn.Linear(2,3)', 'nn.Sequential(nn.Linear(2,16), nn.ReLU(), nn.Linear(8,2))', 'nn.Sequential(nn.Linear(2,64), nn.Linear(64,64), nn.Linear(64,2))']:
            with self.subTest(body=body), self.assertRaises(ValueError):
                review_source('from torch import nn\ndef build_model(): return ' + body)


if __name__ == "__main__":
    unittest.main()
