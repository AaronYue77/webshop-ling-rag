import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training"))
from common import parse_plan


class LivePlannerTest(unittest.TestCase):
    def setUp(self):
        with (ROOT / "data/sft/test.jsonl").open(encoding="utf-8") as file:
            self.plan = json.loads(file.readline())["expected"]

    def test_normalizes_numeric_size_and_single_audience(self):
        raw = json.dumps({**self.plan, "size": 8.5, "audience": ["women"], "size_system": "US"})
        with self.assertRaises(ValueError):
            parse_plan(raw, self.plan)
        result = parse_plan(raw, self.plan, normalize_live=True)
        self.assertEqual((result["size"], result["audience"], result["size_system"]), ("8.5", "women", "US"))

    def test_maps_furniture_to_catalog_category(self):
        raw = json.dumps({**self.plan, "category": "furniture"})
        with self.assertRaises(ValueError):
            parse_plan(raw, self.plan)
        self.assertEqual(parse_plan(raw, self.plan, normalize_live=True)["category"], "garden")

    def test_unknown_or_ambiguous_fields_still_require_a_new_plan(self):
        for changes in ({"audience": ["women", "men"]}, {"category": "unknown"}, {"tasks": ["unsupported"]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                parse_plan(json.dumps({**self.plan, **changes}), self.plan, normalize_live=True)


if __name__ == "__main__":
    unittest.main()
