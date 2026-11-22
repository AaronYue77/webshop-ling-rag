import argparse
import json
import os
import secrets
import threading
import time
from pathlib import Path

from common import DATA, append_json, config_digest, file_digest, generate, load_base, model_config, parse_plan, read_json, read_rows


PLAN_CORRECTION = (
    "\nFormat check: return exactly one complete JSON object matching the schema. "
    "Use strings for non-null size and single values for category, audience, and size_system. "
    "For furniture use category garden. Include only tasks listed above. "
    "Keep the original question, referenced positions, and explicit constraints."
)


def build_app(adapter, journal, token):
    from fastapi import FastAPI, Header, HTTPException
    from fastapi.exception_handlers import request_validation_exception_handler
    from fastapi.exceptions import RequestValidationError
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.requests import Request
    from pydantic import BaseModel, Field

    class PreviousResult(BaseModel):
        position: int = Field(ge=1, le=100)
        id: str = Field(pattern=r"^[A-Z0-9]{10}$")
        name: str = Field(max_length=140)

    class Context(BaseModel):
        lastQuestion: str | None = Field(default=None, max_length=1500)
        active: int | None = Field(default=None, ge=1, le=100)
        previousResults: list[PreviousResult] = Field(default_factory=list, max_length=12)

    class Input(BaseModel):
        question: str = Field(min_length=1, max_length=1500)
        questionId: str | None = Field(default=None, max_length=128)
        context: Context = Field(default_factory=Context)

    sample = read_rows(DATA / "test.jsonl")[0]
    config = read_json(Path(adapter) / "webshop-config.json") if adapter else model_config()
    version = {
        "model": config["model_id"], "revision": config["model_revision"],
        "config_version": config_digest(config),
        "adapter_sha256": file_digest(Path(adapter) / "adapter_model.safetensors") if adapter else None,
        "planner_protocol": 2,
    }
    model, tokenizer, _ = load_base(config)
    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter)
    model.eval()
    # Confirm the GPU and custom attention kernels can run before reporting readiness.
    raw = generate(model, tokenizer, sample["messages"][:-1], {**config, "max_new_tokens": 2})
    append_json(journal, {"event": "ready", "adapter": bool(adapter), "smoke_adapter": config.get("smoke", False),
                          "revision": config["model_revision"], "warmup_generated": bool(raw)})
    lock = threading.Lock()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=["null", "http://127.0.0.1:8800", "http://localhost:8800"],
                       allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"], allow_credentials=False)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError):
        append_json(journal, {"event": "invalid_request", "path": request.url.path,
                              "fields": [item["loc"] for item in error.errors()]})
        return await request_validation_exception_handler(request, error)

    def authorized(value):
        if not value or not secrets.compare_digest(value, "Bearer " + token):
            raise HTTPException(status_code=401, detail="Invalid bearer token")

    @app.get("/health")
    def health(authorization: str | None = Header(default=None)):
        authorized(authorization)
        return {"service": "webshop-ling-planner", "ready": True, "adapter": bool(adapter),
                "smoke_adapter": config.get("smoke", False), "revision": config["model_revision"],
                "model_and_config_version": version}

    @app.post("/v1/plan")
    def plan(payload: Input, authorization: str | None = Header(default=None)):
        authorized(authorization)
        if not lock.acquire(blocking=False):
            raise HTTPException(status_code=429, detail="GPU busy")
        start = time.monotonic()
        stage = "generation"
        attempts = 1
        try:
            context = {"last_question": payload.context.lastQuestion or "", "active_position": payload.context.active,
                       "previous_results": [item.model_dump() for item in payload.context.previousResults]}
            content = json.dumps({"question": payload.question, "context": context}, ensure_ascii=False, separators=(",", ":"))
            messages = [sample["messages"][0], {"role": "user", "content": content}]
            generation_start = time.monotonic()
            raw = generate(model, tokenizer, messages, config)
            stage = "parse"
            try:
                output = parse_plan(raw, sample["expected"], normalize_live=True)
            except ValueError as first_error:
                if time.monotonic() - start >= 55:
                    raise
                append_json(journal, {"event": "plan_retry", "question_id": payload.questionId,
                                      "reason": str(first_error), "model_and_config_version": version})
                system = {**messages[0], "content": messages[0]["content"] + PLAN_CORRECTION}
                stage = "generation"
                attempts += 1
                raw = generate(model, tokenizer, [system, messages[1]], config)
                stage = "parse"
                output = parse_plan(raw, sample["expected"], normalize_live=True)
            generation_ms = round((time.monotonic() - generation_start) * 1000, 3)
            append_json(journal, {"event": "plan_ok", "question_id": payload.questionId,
                                  "seconds": round(time.monotonic()-start, 3),
                                  "generation_ms": generation_ms, "model_and_config_version": version,
                                  "attempts": attempts,
                                  "action": output["action"], "tasks": output["tasks"]})
            return {"plan": output, "adapter": bool(adapter), "smoke_adapter": config.get("smoke", False),
                    "generation_ms": generation_ms, "generation_attempts": attempts, "model_and_config_version": version}
        except (ValueError, TypeError) as err:
            append_json(journal, {"event": "invalid_plan", "question_id": payload.questionId,
                                  "stage": stage, "reason": str(err), "attempts": attempts})
            detail = "Invalid planner output" if stage == "parse" else "Planner input or generation value is invalid"
            raise HTTPException(status_code=422, detail=detail) from err
        except Exception as err:
            append_json(journal, {"event": "gpu_error", "question_id": payload.questionId,
                                  "error": type(err).__name__, "resolution": "windows_fallback"})
            raise HTTPException(status_code=503, detail="GPU inference failed") from err
        finally:
            lock.release()

    return app


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter", help="Local adapter directory. Omit for base mode.")
    parser.add_argument("--port", type=int, default=8008)
    parser.add_argument("--log", default="logs/inference.jsonl")
    args = parser.parse_args()
    token = os.environ.get("WEBSHOP_SERVICE_TOKEN", "")
    if len(token) < 24 or not token.isascii() or any(char.isspace() for char in token):
        parser.error("Set WEBSHOP_SERVICE_TOKEN to an ASCII token of at least 24 characters with no whitespace.")
    try:
        uvicorn.run(build_app(args.adapter, args.log, token), host="127.0.0.1", port=args.port, access_log=False)
    except Exception as exc:
        append_json(args.log, {"event": "startup_failed", "error": type(exc).__name__, "detail": str(exc)})
        raise
