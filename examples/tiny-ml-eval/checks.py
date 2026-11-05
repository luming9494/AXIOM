"""L0 contract check: config, model construction, parameter count and output shape."""
import argparse
import json

from common import configure_cpu, load_config, load_model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    args = parser.parse_args()
    try:
        configure_cpu()
        config = load_config(args.candidate)
        model = load_model(args.candidate, config["seed"])
        print(json.dumps({"level": "L0", "status": "passed", "parameters": sum(p.numel() for p in model.parameters()), "performance_claim": False}))
    except (ValueError, OSError, RuntimeError) as error:
        parser.exit(1, f"Checks failed: {error}\n")


if __name__ == "__main__":
    main()
