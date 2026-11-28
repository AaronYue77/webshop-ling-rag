import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training"))
from common import InvalidPlannerAction, parse_plan
from serve import (ANSWER_PREFIX, action_messages, answer_messages, empty_search_reply, log_answer_failure, parse_answer,
                   parse_followup_answer, prepare_answer_catalog, snapshot_price_comparison)


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
        catalog = {"action": "search", "result_limit": 1, "products": [
            {"position": 1, "description": "Breathable mesh running shoe"},
            {"position": 2, "description": "Black loafer with full-grain leather uppers"},
        ]}
        system, user = answer_messages(question, catalog)
        self.assertIn("Use only the supplied catalog evidence", system["content"])
        self.assertEqual(json.loads(user["content"]), {"question": question, "catalog": catalog})
        good = {"paragraphs": ["可以先看这双乐福鞋，目录明确写了全粒面皮革鞋面。"],
                "selections": [{"position": 2, "quote": "full-grain leather uppers"}]}
        self.assertEqual(parse_answer(json.dumps(good), catalog), good)
        continuation = '{"position":2,"quote":"full-grain leather uppers"}],"paragraphs":["可考虑这双皮鞋。"]}'
        self.assertEqual(parse_answer(ANSWER_PREFIX + continuation, catalog)["selections"], good["selections"])
        for selections in ([{"position": 3, "quote": "full-grain leather uppers"}],
                           good["selections"] * 2):
            with self.subTest(selections=selections), self.assertRaises(ValueError):
                parse_answer(json.dumps({**good, "selections": selections}), catalog)
        self.assertEqual(parse_answer(json.dumps({**good, "selections": []}), catalog)["selections"], [])
        with self.assertRaises(ValueError):
            parse_answer('{"action":"search"}', catalog)

    def test_live_search_requires_reasons_and_prompts_for_other_requested_information(self):
        products = [{"position": 1, "description": "breathable mesh upper",
                     "facts": [["颜色选项", "Black、Grey、Red"], ["尺码选项", "8、8.5、9"]]}]
        question = "找一双 8.5 码的鞋，说明推荐理由、颜色、尺码和历史价格。"
        selection = {"position": 1, "quote": "breathable mesh upper"}
        answer = {"paragraphs": ["平时走路可以优先看这双套脚鞋。"], "selections": [selection]}
        for tasks in (["color", "size", "price_history", "recommend"], ["核对颜色", "核对尺码", "核对历史价格", "解释选择"]):
            with self.subTest(tasks=tasks):
                catalog = {"action": "search", "products": products, "tasks": tasks}
                system, _ = answer_messages(question, catalog)
                for instruction in ("recorded color options", "recorded size options", "no dated price history", '"reason"'):
                    self.assertIn(instruction, system["content"])
                with self.assertRaisesRegex(ValueError, "requires a short catalog-based reason"):
                    parse_answer(json.dumps(answer), catalog)
                complete = {**answer, "selections": [{**selection, "reason": "网面鞋面透气，适合平时步行。"}]}
                self.assertEqual(parse_answer(json.dumps(complete), catalog), complete)
                self.assertEqual(parse_answer(json.dumps({**answer, "selections": []}), catalog)["selections"], [])

    def test_answer_normalizes_outer_json_without_bypassing_evidence_validation(self):
        catalog = {"action": "search", "products": [{"position": 1, "name": "Black leather loafer"}]}
        answer = {"paragraphs": ["可以考虑这双黑色皮革乐福鞋。"],
                  "selections": [{"position": 1, "quote": "leather loafer"}]}
        for raw in ({"answer": answer}, {**answer, "action": "search"}):
            with self.subTest(raw=raw):
                self.assertEqual(parse_answer(json.dumps(raw), catalog), answer)
        with self.assertRaises(ValueError):
            parse_answer(json.dumps({"paragraphs": answer["paragraphs"]}), catalog)

    def test_selection_cites_its_own_catalog_when_ling_paraphrases_or_omits_the_quote(self):
        catalog = {"action": "search", "tasks": ["recommend"], "products": [
            {"position": 1, "name": "Wireless stand", "matched_evidence": ["Folds flat for travel"]},
            {"position": 2, "name": "Protective phone case"},
            {"position": 3},
        ]}
        reason = "可以折叠，出门时好收纳。"
        for quote in ({"quote": "Protective phone case"}, {"quote": "折叠便携"}, {}, {"quote": None}):
            with self.subTest(quote=quote):
                raw = json.dumps({"paragraphs": ["可以考虑这款支架。"],
                                  "selections": [{"position": 1, "reason": reason, **quote}]})
                self.assertEqual(parse_answer(raw, catalog)["selections"],
                                 [{"position": 1, "reason": reason, "quote": "Folds flat for travel"}])
        with self.assertRaisesRegex(ValueError, "no quotable catalog evidence"):
            parse_answer('{"paragraphs":["可考虑"],"selections":[{"position":3,"reason":"方便携带。"}]}', catalog)

    def test_failed_answer_logging_explains_shape_and_limits_private_capture(self):
        catalog = {"action": "search", "products": []}
        private_text = "private shopping note"
        cases = [
            (json.dumps({"answer": {"paragraphs": [private_text], private_text: 1}}),
             {"top_level_type": "dict", "answer_wrapper_type": "dict", "missing_fields": ["selections"],
              "extra_field_count": 1, "field_types": {"paragraphs": "list"}, "array_lengths": {"paragraphs": 1}}),
            ("[]", {"json_valid": True, "top_level_type": "list"}),
            ('{"paragraphs":', {"json_valid": False, "line": 1, "column": 15}),
        ]
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / "public.jsonl"
            debug = Path(directory) / "debug.jsonl"
            for attempt, (raw, expected) in enumerate(cases, start=1):
                with self.subTest(attempt=attempt):
                    with self.assertRaises(ValueError) as raised:
                        parse_answer(raw, catalog)
                    log_answer_failure(journal, None, "invalid_answer", "test-question", attempt, raised.exception, raw)
                    entry = json.loads(journal.read_text(encoding="utf-8").splitlines()[-1])
                    self.assertEqual(entry["attempt"], attempt)
                    for key, value in expected.items():
                        self.assertEqual(entry["output_shape"][key], value)
            self.assertFalse(debug.exists())
            raw = private_text * 300
            log_answer_failure(journal, debug, "answer_retry", "test-question", 1, ValueError("Invalid answer"), ANSWER_PREFIX + raw)
            self.assertNotIn(private_text, journal.read_text(encoding="utf-8"))
            captured = json.loads(debug.read_text(encoding="utf-8"))
            self.assertEqual(captured["assistant_prefix"], ANSWER_PREFIX)
            self.assertEqual(captured["model_output"], raw[:4096])
            self.assertTrue(captured["truncated"])

    def test_comparison_uses_named_items_without_reselecting_them(self):
        products = [{"position": 3, "name": "旅行杯", "snapshot_price_usd": 23.29},
                    {"position": 1, "name": "保温杯", "snapshot_price_usd": 6.99}]
        catalog = {"action": "compare", "products": products, "requested_positions": [3, 1]}
        system, user = answer_messages("这两款差多少钱？", catalog)
        self.assertIn("自然的简体中文", system["content"])
        self.assertIn("纯文本", system["content"])
        self.assertNotIn("selections", system["content"])
        system_en, _ = answer_messages("How much cheaper is item 3?", catalog)
        self.assertIn("plain text", system_en["content"])
        evidence = json.loads(user["content"])["catalog"]
        self.assertEqual(evidence["products"], products)
        self.assertEqual(evidence["snapshot_price_comparison"],
                         {"prices_usd": {"3": "23.29", "1": "6.99"}, "missing_positions": [],
                          "lowest_positions": [1], "highest_positions": [3], "difference_usd": "16.30"})
        prose = "按目录快照价，第 1 款更便宜。第 1 款是 6.99 美元，第 3 款是 23.29 美元，相差 16.30 美元。"
        reply = {"paragraphs": [prose], "selections": []}
        self.assertEqual(parse_followup_answer(prose), reply)
        self.assertEqual(parse_followup_answer(json.dumps({"paragraphs": [prose]})), reply)
        for raw in ("", "[]", '{"action":"compare"}', "<think>internal</think>"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse_followup_answer(raw)

    def test_comparison_marks_equal_missing_and_multiple_snapshot_prices(self):
        products = [{"position": 2, "snapshot_price_usd": 15.25}, {"position": 4, "snapshot_price_usd": 15.25}]
        def compare(items, positions):
            return snapshot_price_comparison({"products": items, "requested_positions": positions})

        tied = compare(products, [2, 4])
        self.assertEqual((tied["difference_usd"], tied["lowest_positions"]), ("0.00", [2, 4]))
        multiple = compare([*products, {"position": 5, "snapshot_price_usd": 20.29}], [2, 4, 5])
        self.assertEqual((multiple["difference_usd"], multiple["highest_positions"]), ("5.04", [5]))
        missing = compare([*products, {"position": 5, "snapshot_price_usd": None}], [2, 4, 5, 7])
        self.assertEqual(missing["missing_positions"], [5, 7])
        self.assertNotIn("difference_usd", missing)

    def test_answer_checks_model_evidence_requirements_before_generation(self):
        catalog = {"action": "search", "required_terms": ["leather"], "excluded_terms": ["faux leather"],
                   "products": [{"position": 1, "name": "Black mesh runner"},
                                {"position": 2, "description": "Upper: Full-grain Leather"},
                                {"position": 3, "description": "Black loafer in faux-leather"}]}
        checked, source_positions = prepare_answer_catalog(catalog)
        self.assertEqual(checked["products"], [{"position": 1, "description": "Upper: Full-grain Leather"}])
        self.assertEqual(source_positions, {1: 2})
        self.assertEqual(len(catalog["products"]), 3)
        checked_reply = parse_answer('{"paragraphs":["推荐这款。"],"selections":[{"position":1,"quote":"Black"}]}', checked)
        self.assertEqual(checked_reply["selections"], [{"position": 1, "quote": "Upper: Full-grain Leather"}])
        comparison = {**catalog, "action": "compare"}
        compared, source_positions = prepare_answer_catalog(comparison)
        self.assertIs(compared, comparison)
        self.assertEqual(source_positions, {})
        empty, source_positions = prepare_answer_catalog({**catalog, "products": catalog["products"][:1]})
        self.assertEqual(source_positions, {})
        reply = empty_search_reply(empty)
        self.assertEqual(reply["selections"], [])
        self.assertIn("目录检索", reply["paragraphs"][0])
        self.assertIsNone(empty_search_reply(comparison))

    def test_live_action_repair_preserves_model_selected_fields(self):
        raw = json.dumps({**self.plan, "action": "search|detail|compare", "required_terms": ["leather"]})
        with self.assertRaises(InvalidPlannerAction) as caught:
            parse_plan(raw, self.plan, normalize_live=True)
        repaired = {**caught.exception.plan, "action": "compare"}
        self.assertEqual(parse_plan(json.dumps(repaired), self.plan, normalize_live=True), repaired)
        self.assertEqual(action_messages("original model input")[1]["content"], "original model input")


if __name__ == "__main__":
    unittest.main()
