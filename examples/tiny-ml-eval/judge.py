"""Final objective score for trusted Tiny Task candidates, NOT a full compliance sandbox."""
import argparse
import json

from common import TASK, TASK_PATH, sha256, write_json
from evaluate import evaluate


def judge(run):
    goal = TASK["goal"]
    metrics = evaluate(run, goal["split"])
    score = metrics[goal["metric"]]
    met = score >= goal["target"]
    return {
        "task_id": TASK["task_id"], "task_sha256": sha256(TASK_PATH),
        "metric_status": "target_met" if met else "best_effort",
        "valid_model": True, "goal": goal, "metrics": metrics,
        "compliance_status": "not_fully_verified",
        "notice": "Objective metric judgment only. No Agent, budget controller or hostile-code sandbox is implemented in WP-01.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--output", required=True, help="New final judgment file; never overwrite")
    args = parser.parse_args()
    try:
        result = judge(args.run)
        write_json(args.output, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, RuntimeError, KeyError, TypeError) as error:
        parser.exit(1, f"Judgment failed: {error}\n")


if __name__ == "__main__":
    main()
