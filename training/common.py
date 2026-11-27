import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path(__file__).with_name("config.json")
DATA = ROOT / "data" / "sft"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def read_rows(path):
    with Path(path).open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def append_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"time": datetime.now(timezone.utc).isoformat(), **data}, ensure_ascii=False) + "\n")


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def config_digest(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def model_config():
    config = read_json(CONFIG)
    revision = os.environ.get("WEBSHOP_MODEL_REVISION", config["model_revision"])
    if revision in {"main", ""}:
        from huggingface_hub import HfApi
        revision = HfApi().model_info(config["model_id"], revision="main").sha
    if not revision or len(revision) != 40:
        raise RuntimeError("Use a full Hugging Face commit SHA for WEBSHOP_MODEL_REVISION.")
    config["model_revision"] = revision
    return config


def startup_step(name):
    if os.environ.get("WEBSHOP_STARTUP_PROGRESS") == "1":
        print(f"WEBSHOP_STARTUP {name}", flush=True)


def load_base(config, train=False):
    import torch
    from huggingface_hub import snapshot_download
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    if not torch.cuda.is_available():
        raise RuntimeError("A CUDA GPU is required. Enable one in Kaggle and run the smoke test.")
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported(including_emulation=False) else torch.float16
    if torch.cuda.get_device_capability(0)[0] < 8:
        logging.warning("Pre-Ampere GPU. FLA kernel support must pass the smoke test. Select L4 or A100 if Triton fails.")
    startup_step("download")
    snapshot = snapshot_download(config["model_id"], revision=config["model_revision"])
    startup_step("load")
    tokenizer = AutoTokenizer.from_pretrained(snapshot, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                               bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=dtype)
    model = AutoModelForCausalLM.from_pretrained(
        snapshot, trust_remote_code=True, quantization_config=quant, torch_dtype=dtype,
        device_map={"": 0}, attn_implementation="eager",
    )
    if train:
        model.config.use_cache = False
    model.generation_config.pad_token_id = tokenizer.pad_token_id
    return model, tokenizer, dtype


PLAN_ACTIONS = ("search", "detail", "compare")


class InvalidPlannerAction(ValueError):
    def __init__(self, plan):
        super().__init__("Invalid planner action.")
        self.plan = plan


def parse_plan(text, schema, *, allow_numeric_size=False, normalize_live=False):
    decoder = json.JSONDecoder()
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = candidate.split("\n", 1)[-1].removesuffix("```").strip()
    plan, end = decoder.raw_decode(candidate)
    if normalize_live and isinstance(plan, dict) and set(plan) == {"plan"}:
        plan = plan["plan"]
    optional = {"required_terms", "excluded_terms"} if normalize_live else set()
    if (candidate[end:].strip() or not isinstance(plan, dict)
            or not set(schema) <= set(plan) <= set(schema) | optional):
        raise ValueError("Planner output must contain exactly the schema keys.")
    if normalize_live:
        for key in ("category", "audience", "size_system", "color"):
            if isinstance(plan[key], list) and len(plan[key]) == 1:
                plan[key] = plan[key][0]
        for key in ("action", "category", "audience", "sort", "budget_scope"):
            if isinstance(plan[key], str):
                plan[key] = plan[key].strip().lower()
        if isinstance(plan["size_system"], str):
            plan["size_system"] = plan["size_system"].strip().upper()
        if plan["category"] == "furniture":
            plan["category"] = "garden"
        if isinstance(plan["limit"], str) and re.fullmatch(r"[0-9]{1,2}", plan["limit"]):
            plan["limit"] = int(plan["limit"])
        if isinstance(plan["refs"], list):
            plan["refs"] = [int(ref) if isinstance(ref, str) and re.fullmatch(r"[0-9]{1,3}", ref) else ref
                            for ref in plan["refs"]]
        for key in optional.intersection(plan):
            values = plan[key]
            if not isinstance(values, list) or len(values) > 8 or any(
                not isinstance(value, str) or len(value) > 55 or not re.search(r"[A-Za-z0-9]", value)
                for value in values
            ):
                raise ValueError(f"Invalid planner evidence phrases in {key}.")
            plan[key] = list(dict.fromkeys(value.strip() for value in values))
    if not all(isinstance(plan[key], list) for key in ("refs", "tasks", "terms")):
        raise ValueError("Invalid planner lists.")
    if not all(type(x) is int and 1 <= x <= 100 for x in plan["refs"]):
        raise ValueError("Invalid product position.")
    if not all(isinstance(x, str) and len(x) <= 130 for key in ("tasks", "terms") for x in plan[key]):
        raise ValueError("Invalid planner list value.")
    if not all(plan[key] is None or type(plan[key]) in (int, float) and 0 <= plan[key] <= 100000 for key in ("min_price", "max_price")):
        raise ValueError("Invalid price.")
    enums = {
        "category": {None, "beauty", "electronics", "fashion", "garden", "grocery"},
        "audience": {None, "women", "men", "kids"},
        "size_system": {None, "US", "UK", "EU"},
        "sort": {"relevance", "price_asc", "price_desc"},
        "budget_scope": {"item", "total"},
    }
    if any(not isinstance(plan[key], (str, type(None))) or plan[key] not in values for key, values in enums.items()):
        raise ValueError("Invalid planner enum.")
    size = plan["size"]
    if (allow_numeric_size or normalize_live) and type(size) in (int, float) and 0 < size <= 300:
        plan["size"] = str(int(size)) if int(size) == size else str(size)
    if not all(plan[key] is None or isinstance(plan[key], str) for key in ("size", "color", "compatibility_target")):
        raise ValueError("Invalid filter value.")
    if not all(type(plan[key]) is bool for key in ("shoe", "price_exclusive")) or type(plan["limit"]) is not int or not 1 <= plan["limit"] <= 12:
        raise ValueError("Invalid planner scalar.")
    if not set(plan["tasks"]) <= {"image", "price", "price_history", "size", "color", "material", "specs", "recommend",
                                 "compare", "variant_price", "inventory", "compatibility", "current_price"}:
        raise ValueError("Invalid planner task.")
    if plan["action"] not in PLAN_ACTIONS:
        raise InvalidPlannerAction(plan)
    return plan


def generate(model, tokenizer, messages, config, *, choices=(), assistant_prefix=""):
    import torch
    prompt = (tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
              + assistant_prefix)
    batch = tokenizer(prompt, return_tensors="pt", add_special_tokens=False, return_token_type_ids=False)
    prompt_limit = config.get("prompt_token_limit", 2048)
    if batch["input_ids"].shape[1] > prompt_limit:
        raise ValueError(f"Prompt exceeds {prompt_limit} tokens.")
    prompt_length = batch["input_ids"].shape[1]
    batch = batch.to(model.get_input_embeddings().weight.device)
    eos = [tokenizer.eos_token_id]
    generation_options = {"max_new_tokens": config["max_new_tokens"]}
    if choices:
        candidates = [tokenizer.encode(choice, add_special_tokens=False) + eos for choice in choices]

        def allowed_tokens(_batch_id, input_ids):
            prefix = input_ids[prompt_length:].tolist()
            return [candidate[len(prefix)] for candidate in candidates if candidate[:len(prefix)] == prefix]

        generation_options = {"max_new_tokens": max(map(len, candidates)), "prefix_allowed_tokens_fn": allowed_tokens}
    with torch.inference_mode():
        out = model.generate(**batch, do_sample=False, temperature=1.0, top_p=1.0, top_k=50,
                             eos_token_id=eos, use_cache=True, **generation_options)
    return assistant_prefix + tokenizer.decode(out[0, prompt_length:], skip_special_tokens=True)
