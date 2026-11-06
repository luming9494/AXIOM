"""Fixed WP-04 CPU worker. Independent evaluation runs in a separate process."""
import argparse
import json
from pathlib import Path
from review_candidate import review_source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--smoke-output")
    args = parser.parse_args()
    try:
        source = (Path(args.candidate) / "model.py").read_bytes().decode("utf-8")
        review_source(source)  # Before any candidate import.
        from train import train
        if args.smoke_output:
            train(args.candidate, args.smoke_output, "smoke")
        result = train(args.candidate, args.output, "full")
        print(json.dumps(result))
    except (ValueError, OSError, RuntimeError, SyntaxError) as error:
        parser.exit(1, f"Experiment failed: {error}\n")


if __name__ == "__main__":
    main()
