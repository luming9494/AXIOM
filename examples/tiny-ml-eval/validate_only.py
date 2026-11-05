"""WP-03 fixed validation-only entrypoint. Never generate or evaluate final-test data."""
import argparse
import json
from pathlib import Path

import common


def validate(run):
    accesses = []
    original = common.dataset

    def validation_dataset(split):
        if split != "validation":
            raise ValueError("WP-03 forbids every evaluation split except validation")
        accesses.append(split)
        return original(split)

    # evaluate imports dataset from common; patch only in this short-lived process.
    import evaluate as evaluator
    previous = evaluator.dataset
    evaluator.dataset = validation_dataset
    try:
        result = evaluator.evaluate(run, "validation")
    finally:
        evaluator.dataset = previous
    result["dataset_access_log"] = accesses
    result["evaluation_entrypoint_sha256"] = common.sha256(Path(__file__))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    try:
        result = validate(args.run)
        if args.output:
            common.write_json(args.output, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, RuntimeError, KeyError, TypeError) as error:
        parser.exit(1, f"Validation failed: {error}\n")


if __name__ == "__main__":
    main()
