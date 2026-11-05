"""Trusted Tiny Task helpers. Candidate Python execution is NOT sandboxed."""
import hashlib
import importlib.util
import json
import math
from pathlib import Path

import torch
from torch import nn

TASK_PATH = Path(__file__).parent / "task.json"
TASK = json.loads(TASK_PATH.read_text(encoding="utf-8"))
PROTOCOL = TASK["protocol"]
SPLITS = {name: (item["samples"], item["seed"]) for name, item in TASK["dataset"].items()}
MAX_PARAMETERS = TASK["rules"]["max_parameters"]


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dataset(split):
    if split not in SPLITS:
        raise ValueError("Unknown data split")
    size, seed = SPLITS[split]
    generator = torch.Generator().manual_seed(seed)
    # Balanced classes, independent noise and permutations per split; no network IO.
    centers = torch.tensor([[-1., -1.], [-1., 1.], [1., -1.], [1., 1.]])
    groups = torch.arange(size) % 4
    x = centers[groups] + 0.30 * torch.randn(size, 2, generator=generator)
    y = ((groups == 0) | (groups == 3)).long()
    order = torch.randperm(size, generator=generator)
    return x[order], y[order]


def load_config(candidate):
    config = json.loads((Path(candidate) / "config.json").read_text(encoding="utf-8"))
    if not isinstance(config, dict) or set(config) != {"epochs", "learning_rate", "seed"}:
        raise ValueError("Config must contain exactly epochs, learning_rate, seed")
    min_epochs, max_epochs = TASK["rules"]["epochs_range"]
    min_lr, max_lr = TASK["rules"]["learning_rate_range"]
    if type(config["epochs"]) is not int or not min_epochs <= config["epochs"] <= max_epochs:
        raise ValueError("epochs must be an integer in [1, 120]")
    if type(config["seed"]) is not int or not 0 <= config["seed"] < 2**31:
        raise ValueError("seed must be a nonnegative 31-bit integer")
    lr = config["learning_rate"]
    if type(lr) not in (float, int) or not math.isfinite(lr) or not min_lr <= lr <= max_lr:
        raise ValueError("learning_rate must be finite and in [0.0001, 0.1]")
    return config


def load_model(candidate, seed):
    path = Path(candidate) / "model.py"
    torch.manual_seed(seed)
    spec = importlib.util.spec_from_file_location("tiny_candidate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model = module.build_model()
    if not isinstance(model, nn.Module):
        raise ValueError("build_model must return torch.nn.Module")
    model = model.cpu()
    parameters = sum(parameter.numel() for parameter in model.parameters())
    if not 1 <= parameters <= MAX_PARAMETERS:
        raise ValueError(f"Parameter count must be in [1, {MAX_PARAMETERS}]")
    with torch.no_grad():
        logits = model(torch.zeros(4, 2))
    if logits.shape != (4, 2) or not torch.isfinite(logits).all():
        raise ValueError("Model must return finite [batch, 2] logits")
    return model


def write_json(path, value):
    # Never silently overwrite previous evidence or results.
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def configure_cpu():
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
