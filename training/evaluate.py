import argparse
import contextlib
import json
import time
from collections import defaultdict
from pathlib import Path

from common import DATA, append_json, config_digest, file_digest, generate, load_base, parse_plan, read_json, read_rows, write_json


def match(field, actual, expected):
    if field in ("tasks", "terms", "refs"):
        normalize = lambda xs: {str(x).strip().casefold() for x in xs}
        return normalize(actual) == normalize(expected)
    if isinstance(expected, str):
        return isinstance(actual, str) and actual.strip().casefold() == expected.strip().casefold()
    return actual == expected


def metrics(rows):
    result = defaultdict(float)
    by_family = defaultdict(list)
    for row in rows:
        actual, gold = row.get("plan"), row["expected"]
        valid = actual is not None
        result["valid_json"] += int(valid)
        for field in ("action", "refs", "category", "limit", "compatibility_target"):
            result[field + "_accuracy"] += int(valid and match(field, actual[field], gold[field]))
        constraints = ("category", "audience", "shoe", "size", "size_system", "color", "max_price", "min_price", "price_exclusive", "budget_scope", "sort")
        result["constraints_exact"] += int(valid and all(match(k, actual[k], gold[k]) for k in constraints))
        actual_tasks, expected_tasks = set(actual["tasks"]) if valid else set(), set(gold["tasks"])
        precision = len(actual_tasks & expected_tasks) / max(1, len(actual_tasks))
        recall = len(actual_tasks & expected_tasks) / max(1, len(expected_tasks))
        result["task_macro_f1"] += 2 * precision * recall / (precision + recall) if precision + recall else int(valid and not actual_tasks and not expected_tasks)
        exact = valid and all(match(k, actual[k], value) for k, value in gold.items())
        result["plan_exact"] += int(exact)
        by_family[row["family"]].append(int(exact))
    return {"samples": len(rows), **{k: round(v / max(1, len(rows)), 6) for k, v in result.items()},
            "family_plan_exact": {k: {"n": len(v), "score": round(sum(v)/len(v), 6)} for k, v in sorted(by_family.items())}}


def main(args):
    from peft import PeftModel

    folder = Path(args.output)
    adapter = Path(args.adapter)
    config = read_json(adapter / "webshop-config.json")
    path = DATA / (args.split + ".jsonl")
    rows = read_rows(path)
    if args.limit:
        rows = rows[:args.limit]
    fingerprints = {"evaluation_version": 3, "model_revision": config["model_revision"], "split": args.split,
                    "model_id": config["model_id"], "config_version": config_digest(config),
                    "data_sha256": file_digest(path),
                    "adapter_sha256": file_digest(adapter / "adapter_model.safetensors"), "limit": args.limit}
    manifest = folder / "evaluation-config.json"
    if manifest.exists() and read_json(manifest) != fingerprints:
        raise ValueError("The existing evaluation output uses a different model or dataset. Choose a fresh output directory.")
    write_json(manifest, fingerprints)
    model, tokenizer, _ = load_base(config)
    model = PeftModel.from_pretrained(model, adapter).eval()
    reports = {}
    for mode in ("base", "adapter"):
        output = folder / (mode + "-predictions.jsonl")
        previous = {p["id"]: p for p in read_rows(output)} if output.exists() else {}
        with model.disable_adapter() if mode == "base" else contextlib.nullcontext():
            for i, row in enumerate(rows):
                if row["id"] in previous:
                    continue
                start = time.monotonic()
                pred = {"id": row["id"], "family": row["family"], "expected": row["expected"], "plan": None}
                pred["raw"] = generate(model, tokenizer, row["messages"][:-1], config)
                pred["generation_ms"] = round((time.monotonic() - start) * 1000, 3)
                try:
                    pred["plan"] = parse_plan(pred["raw"], row["expected"])
                except (ValueError, TypeError) as error:
                    pred["parse_error"] = str(error)
                pred["elapsed_s"] = round(time.monotonic() - start, 2)
                previous[row["id"]] = pred
                append_json(output, pred)
                print(f"{mode} {i + 1}/{len(rows)} {row['id']} valid={pred['plan'] is not None}", flush=True)
        reports[mode] = metrics([previous[r["id"]] for r in rows])
    delta = {k: round(reports["adapter"][k]-reports["base"][k], 6)
             for k, value in reports["base"].items() if isinstance(value, float)}
    report = {**fingerprints, "smoke_adapter": config.get("smoke", False), **reports, "delta": delta}
    write_json(folder / "comparison.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--split", choices=("validation", "test"), default="test")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    main(args)
