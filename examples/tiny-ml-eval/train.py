"""Controlled CPU training entry. Run only reviewed, trusted candidate code."""
import argparse
import json
import shutil
import time
from pathlib import Path

import torch
from torch import nn

from common import PROTOCOL, configure_cpu, dataset, load_config, load_model, sha256, write_json


def train(candidate, output, level="full"):
    if level not in {"smoke", "proxy", "full"}:
        raise ValueError("Unknown execution level")
    started = time.perf_counter()
    configure_cpu()
    candidate, output = Path(candidate).resolve(), Path(output).resolve()
    config = load_config(candidate)
    if output == candidate or candidate in output.parents or output in candidate.parents:
        raise ValueError("Output and candidate directories must not contain each other")
    output.mkdir(parents=True, exist_ok=False)
    snapshot = output / "candidate"
    snapshot.mkdir()
    for name in ("model.py", "config.json"):
        source = candidate / name
        if source.is_symlink() or not source.is_file():
            raise ValueError("Candidate inputs must be regular files, not symlinks")
        shutil.copyfile(source, snapshot / name)
    model = load_model(snapshot, config["seed"])
    x, y = dataset("train")
    epochs = config["epochs"]
    if level == "smoke":
        x, y, epochs = x[:16], y[:16], 2
    elif level == "proxy":
        x, y, epochs = x[:256], y[:256], min(20, epochs)
    optimizer = torch.optim.Adam(model.parameters(), lr=config["learning_rate"])
    criterion = nn.CrossEntropyLoss()
    history = []
    model.train()
    for epoch in range(epochs):
        optimizer.zero_grad()
        logits = model(x)
        loss = criterion(logits, y)
        if not torch.isfinite(loss):
            raise ValueError("Training produced a nonfinite loss")
        loss.backward()
        if any(p.grad is not None and not torch.isfinite(p.grad).all() for p in model.parameters()):
            raise ValueError("Training produced nonfinite gradients")
        optimizer.step()
        history.append({"epoch": epoch + 1, "loss": float(loss.detach())})
    checkpoint = output / "checkpoint.pt"
    torch.save(model.state_dict(), checkpoint)
    write_json(output / "history.json", history)
    source_hashes = {name: sha256(snapshot / name) for name in ("model.py", "config.json")}
    trusted = Path(__file__).parent
    metadata = {
        "schema_version": 1, "protocol": PROTOCOL, "status": "trained",
        "level": level, "config": config, "epochs_executed": epochs,
        "train_samples": len(y), "parameter_count": sum(p.numel() for p in model.parameters()),
        "candidate_sha256": source_hashes, "checkpoint_sha256": sha256(checkpoint),
        "evaluator_sha256": {name: sha256(trusted / name) for name in ("task.json", "common.py", "train.py", "evaluate.py", "judge.py")},
        "torch_version": str(torch.__version__), "device": "cpu",
        "wall_seconds": time.perf_counter() - started,
    }
    write_json(output / "run.json", metadata)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", required=True, help="New directory; existing directories are rejected")
    parser.add_argument("--level", choices=("smoke", "proxy", "full"), default="full")
    args = parser.parse_args()
    try:
        print(json.dumps(train(args.candidate, args.output, args.level), ensure_ascii=False, indent=2))
    except (ValueError, OSError, RuntimeError) as error:
        parser.exit(1, f"Training failed: {error}\n")


if __name__ == "__main__":
    main()
