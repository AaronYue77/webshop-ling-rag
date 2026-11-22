import argparse
import importlib.metadata
import traceback
from pathlib import Path

from common import DATA, append_json, file_digest, load_base, model_config, read_rows, write_json


def tokenized(example, tokenizer, max_length):
    messages = example["messages"]
    prefix = tokenizer.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    completion = messages[-1]["content"]
    prefix_ids = tokenizer(prefix, add_special_tokens=False)["input_ids"]
    target_ids = tokenizer(completion, add_special_tokens=False)["input_ids"] + [tokenizer.eos_token_id]
    if len(prefix_ids) + len(target_ids) > max_length:
        raise ValueError(f"{example['id']} exceeds max_length. Raise max_length or shorten the evidence context.")
    return {"input_ids": prefix_ids + target_ids, "attention_mask": [1] * (len(prefix_ids) + len(target_ids)),
            "labels": [-100] * len(prefix_ids) + target_ids}


def main(args):
    import torch
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import Trainer, TrainerCallback, TrainingArguments, set_seed

    dest = Path(args.output)
    journal = dest / "logs" / "training.jsonl"
    config = model_config()
    set_seed(config["seed"])
    training = read_rows(DATA / "train.jsonl")
    validation = read_rows(DATA / "validation.jsonl")
    if args.smoke:
        training = training[:3]
        validation = validation[:1]
    else:
        validation = sorted(validation, key=lambda row: row["id"])[::6][:config["validation_loss_examples"]]
    signature = {"config": config, "smoke": args.smoke, "train_rows": len(training), "validation_loss_rows": len(validation),
                 "train_sha256": file_digest(DATA / "train.jsonl"), "validation_sha256": file_digest(DATA / "validation.jsonl")}
    signature_file = dest / "run-config.json"
    if signature_file.exists():
        from common import read_json
        if not args.resume or read_json(signature_file) != signature:
            raise RuntimeError("Output directory belongs to a previous run. Use its checkpoint with --resume, or choose a fresh directory.")
    else:
        write_json(signature_file, signature)
    model, tokenizer, dtype = load_base(config, train=True)
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True,
                                           gradient_checkpointing_kwargs={"use_reentrant": False})
    targets = [name for name in config["target_modules"] if any(path.endswith("." + name) for path, _ in model.named_modules())]
    if "o_proj" not in targets or len(targets) < 2:
        raise RuntimeError(f"Unexpected model attention projections: {targets}")
    model = get_peft_model(model, LoraConfig(r=config["lora_rank"], lora_alpha=config["lora_alpha"],
                                           lora_dropout=config["lora_dropout"], bias="none",
                                           task_type="CAUSAL_LM", target_modules=targets))
    trainable, total = model.get_nb_trainable_parameters()
    append_json(journal, {"event": "started", **signature, "trainable_params": trainable, "total_params": total,
                          "target_modules": targets, "gpu": torch.cuda.get_device_name(0), "dtype": str(dtype),
                          "packages": {p: importlib.metadata.version(p) for p in ("torch", "transformers", "peft", "bitsandbytes", "fla-core")}})
    train_data = [tokenized(row, tokenizer, config["max_length"]) for row in training]
    eval_data = [tokenized(row, tokenizer, config["max_length"]) for row in validation]

    def batch_one(examples):
        if len(examples) != 1:
            raise ValueError("This recipe uses one sequence per device and gradient accumulation.")
        return {key: torch.tensor([examples[0][key]], dtype=torch.long) for key in ("input_ids", "attention_mask", "labels")}

    class Journal(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kwargs):
            append_json(journal, {"event": "metrics", "step": state.global_step, **(logs or {})})

        def on_save(self, args, state, control, **kwargs):
            append_json(journal, {"event": "checkpoint", "step": state.global_step,
                                  "path": str(Path(args.output_dir) / f"checkpoint-{state.global_step}")})

    params = TrainingArguments(
        output_dir=str(dest / "checkpoints"), learning_rate=config["learning_rate"],
        per_device_train_batch_size=1, per_device_eval_batch_size=1,
        gradient_accumulation_steps=1 if args.smoke else config["gradient_accumulation_steps"],
        max_steps=1 if args.smoke else -1, num_train_epochs=config["epochs"],
        warmup_ratio=0.0 if args.smoke else config["warmup_ratio"],
        lr_scheduler_type="constant" if args.smoke else "cosine",
        gradient_checkpointing=True, gradient_checkpointing_kwargs={"use_reentrant": False},
        bf16=dtype == torch.bfloat16, fp16=dtype == torch.float16,
        optim="paged_adamw_8bit", max_grad_norm=1.0,
        logging_steps=config["logging_steps"], logging_nan_inf_filter=False,
        save_strategy="steps", save_steps=config["save_steps"], save_total_limit=2,
        eval_strategy="steps", eval_steps=1 if args.smoke else config["eval_steps"],
        prediction_loss_only=True, remove_unused_columns=False, label_names=["labels"],
        seed=config["seed"], data_seed=config["seed"], report_to="none",
    )
    trainer = Trainer(model=model, args=params, train_dataset=train_data, eval_dataset=eval_data,
                      data_collator=batch_one, processing_class=tokenizer, callbacks=[Journal()])
    result = trainer.train(resume_from_checkpoint=args.resume)
    trainer.save_model(str(dest / "adapter"))
    tokenizer.save_pretrained(dest / "adapter")
    write_json(dest / "adapter" / "webshop-config.json", {**config, "smoke": args.smoke, "train_sha256": signature["train_sha256"]})
    append_json(journal, {"event": "completed", **result.metrics, "adapter": str(dest / "adapter")})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--resume", help="Path to a compatible Hugging Face Trainer checkpoint.")
    options = parser.parse_args()
    try:
        main(options)
    except Exception as exc:
        append_json(Path(options.output) / "logs" / "training.jsonl",
                    {"event": "failed", "error": type(exc).__name__, "detail": str(exc), "trace": traceback.format_exc()})
        raise
