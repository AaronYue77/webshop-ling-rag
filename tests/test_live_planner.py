import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training"))
from common import parse_plan
from serve import answer_messages, answer_paragraphs


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

    def test_live_evidence_keys_and_equivalent_json_representations(self):
        generated = {**self.plan, "refs": ["2"], "limit": "4", "color": ["black"],
                     "required_terms": ["leather"], "excluded_terms": ["faux leather"]}
        raw = json.dumps({"plan": generated})
        result = parse_plan(raw, self.plan, normalize_live=True)
        self.assertEqual(result["refs"], [2])
        self.assertEqual(result["limit"], 4)
        self.assertEqual(result["color"], "black")
        self.assertEqual(result["required_terms"], ["leather"])
        self.assertEqual(result["excluded_terms"], ["faux leather"])
        with self.assertRaises(ValueError):
            parse_plan(json.dumps(generated), self.plan)

    def test_invalid_evidence_filters_cannot_be_silently_ignored(self):
        for terms in ("leather", [""], [True]):
            with self.subTest(terms=terms), self.assertRaises(ValueError):
                parse_plan(json.dumps({**self.plan, "required_terms": terms}), self.plan, normalize_live=True)

    def test_answer_generation_uses_question_and_evidence_as_data(self):
        question = "可以推荐黑色皮鞋吗？"
        catalog = {"products": [{"position": 1, "facts": [["材质", "leather"]]}]}
        system, user = answer_messages(question, catalog)
        self.assertIn("Use only the supplied catalog evidence", system["content"])
        self.assertEqual(json.loads(user["content"]), {"question": question, "catalog": catalog})
        self.assertEqual(answer_paragraphs("  目录注明使用皮革。\n\n  库存请另行确认。  "),
                         ["目录注明使用皮革。", "库存请另行确认。"])
        with self.assertRaises(ValueError):
            answer_paragraphs('{"action":"search"}')


if __name__ == "__main__":
    unittest.main()
