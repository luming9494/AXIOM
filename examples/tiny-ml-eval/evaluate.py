"""Independent evaluator: recompute metrics from checkpoint, never read reported metrics."""
import argparse
import json
import math
import time
from pathlib import Path

import torch
from torch import nn

from common import PROTOCOL, configure_cpu, dataset, load_config, load_model, sha256, write_json


def evaluate(run, split="validation"):
    if split not in {"validation", "final-test"}:
        raise ValueError("Only validation and final-test may be evaluated")
    started = time.perf_counter()
    configure_cpu()
    run = Path(run).resolve()
    metadata = json.loads((run / "run.json").read_text(encoding="utf-8"))
    if metadata.get("schema_version") != 1 or metadata.get("protocol") != PROTOCOL or metadata.get("status") != "trained":
        raise ValueError("Unsupported or incomplete run metadata")
    if metadata.get("level") not in {"smoke", "proxy", "full"}:
        raise ValueError("Invalid execution level")
    if split == "final-test" and metadata["level"] != "full":
        raise ValueError("Smoke/proxy results cannot be used as formal final-test scores")
    if metadata.get("torch_version") != str(torch.__version__):
        raise ValueError("PyTorch version differs from training environment")
    for name in ("task.json", "common.py", "train.py", "evaluate.py", "judge.py"):
        if metadata.get("evaluator_sha256", {}).get(name) != sha256(Path(__file__).parent / name):
            raise ValueError("Trusted evaluator/trainer changed; do not silently reuse this run")
    candidate = run / "candidate"
    for name in ("model.py", "config.json"):
        if metadata.get("candidate_sha256", {}).get(name) != sha256(candidate / name):
            raise ValueError("Candidate snapshot hash mismatch")
    checkpoint = run / "checkpoint.pt"
    if metadata.get("checkpoint_sha256") != sha256(checkpoint):
        raise ValueError("Checkpoint hash mismatch")
    config = load_config(candidate)
    if config != metadata.get("config"):
        raise ValueError("Run config differs from snapshot")
    expected_epochs = {"smoke": 2, "proxy": min(20, config["epochs"]), "full": config["epochs"]}[metadata["level"]]
    expected_samples = {"smoke": 16, "proxy": 256, "full": 1024}[metadata["level"]]
    if metadata.get("epochs_executed") != expected_epochs or metadata.get("train_samples") != expected_samples:
        raise ValueError("Training scope does not match claimed execution level")
    model = load_model(candidate, config["seed"])
    # weights_only prevents loading arbitrary pickled objects; model.py itself is still executable.
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(state, strict=True)
    model.eval()
    x, y = dataset(split)
    with torch.no_grad():
        logits = model(x)
        if logits.shape != (len(y), 2) or not torch.isfinite(logits).all():
            raise ValueError("Invalid evaluation logits")
        loss = float(nn.CrossEntropyLoss()(logits, y))
        accuracy = float((logits.argmax(dim=1) == y).float().mean())
    if not math.isfinite(loss):
        raise ValueError("Nonfinite evaluation loss")
    return {
        "schema_version": 1, "protocol": PROTOCOL, "split": split, "level": metadata["level"],
        "accuracy": accuracy, "loss": loss, "samples": len(y),
        "checkpoint_sha256": sha256(checkpoint), "run_metadata_sha256": sha256(run / "run.json"),
        "wall_seconds": time.perf_counter() - started,
        "scope": "formal tiny-task evaluation" if split == "final-test" else "validation feedback only",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--split", choices=("validation", "final-test"), default="validation")
    parser.add_argument("--output", help="Optional new JSON file; existing files are rejected")
    args = parser.parse_args()
    try:
        result = evaluate(args.run, args.split)
        if args.output:
            write_json(args.output, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, RuntimeError, KeyError, TypeError) as error:
        parser.exit(1, f"Evaluation failed: {error}\n")


if __name__ == "__main__":
    main()
