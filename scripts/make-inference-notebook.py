"""Build the inference-only Kaggle notebook from the local WebShop runtime."""
import base64
import hashlib
import io
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "kaggle/webshop-ling-inference.ipynb"
FORMAL_ADAPTER = ROOT / "runs/webshop-run/adapter"
FORMAL_WEIGHTS_SHA = "a12308ed323e764e3a14fb3437a9371e8d839394cfa27f134e9db65c2e86b8c9"
ABOUT = """# WebShop Ling-3.0-tiny LoRA Inference

1. 点 **Copy & Edit** 打开自己的副本。
2. 在 **Settings** 启用 **Internet**，将 **Accelerator** 设为 GPU，随后点 **Run All**。
3. 等待输出 **WebShop LoRA 已就绪**。进入 **Run → Kaggle Jupyter Server**，复制 **VSCode Compatible URL**，粘贴到 WebShop 问答台。问答期间保持会话运行。

本 Notebook 自动下载并核对 [GitHub Release 中的正式 LoRA](https://github.com/AaronYue77/webshop-ling-rag/releases/tag/v1.0.0)。模型就绪后，把 Kaggle 会话地址粘贴到问答台。
"""

BOOTSTRAP = """from pathlib import Path
import base64
import hashlib
import io
import json
import os
import secrets
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import Request, urlopen, urlretrieve
from zipfile import ZipFile

import torch

if not torch.cuda.is_available():
    raise RuntimeError("在 Settings → Accelerator 选择 GPU，再点击 Run All。")

work = Path("/kaggle/working")
repo = work / "webshop-inference"
release = "https://github.com/AaronYue77/webshop-ling-rag/releases/download/v1.0.0"
adapter_hashes = __ADAPTER_HASHES__


def matches_formal_adapter(folder):
    for name, expected in adapter_hashes.items():
        path = folder / name
        if not path.is_file():
            return False
        with path.open("rb") as file:
            if hashlib.file_digest(file, "sha256").hexdigest() != expected:
                return False
    return True


def load_adapter():
    for config in Path("/kaggle/input").rglob("webshop-run/adapter/webshop-config.json"):
        if matches_formal_adapter(config.parent):
            return config.parent

    adapter = work / "webshop-formal-adapter"
    if matches_formal_adapter(adapter):
        return adapter
    print("正在从 GitHub Release 下载正式 LoRA。", flush=True)
    adapter.mkdir(parents=True, exist_ok=True)
    for name in adapter_hashes:
        urlretrieve(f"{release}/{name}", adapter / name)
    if not matches_formal_adapter(adapter):
        raise RuntimeError("正式权重完整性校验失败。请核对 GitHub Release 后重新运行。")
    return adapter


adapter = load_adapter()
repo.mkdir(parents=True, exist_ok=True)
with ZipFile(io.BytesIO(base64.b64decode(_webshop_runtime))) as runtime:
    runtime.extractall(repo)

print("正在安装推理依赖并准备模型。首次启动需要下载基座模型。", flush=True)
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(repo / "training/requirements.txt")],
               check=True)

previous = globals().get("webshop_service")
if previous is not None and previous.poll() is None:
    previous.terminate()
    try:
        previous.wait(timeout=10)
    except subprocess.TimeoutExpired:
        previous.kill()
        previous.wait()

# 进程内生成临时凭据。服务只监听 Kaggle 容器的回环地址。
service_env = {
    **os.environ,
    "WEBSHOP_SERVICE_TOKEN": secrets.token_urlsafe(32),
    "CUDA_VISIBLE_DEVICES": "0",
    "TOKENIZERS_PARALLELISM": "false",
    "HF_HOME": "/kaggle/temp/webshop-hf",
}
log_path = work / "webshop-inference-start.log"
with log_path.open("w", encoding="utf-8") as log:
    webshop_service = subprocess.Popen(
        [sys.executable, "training/serve.py", "--adapter", str(adapter), "--log", str(work / "webshop-inference.jsonl")],
        cwd=repo, env=service_env, stdout=log, stderr=subprocess.STDOUT,
    )

print("正在加载正式 LoRA 权重并进行 GPU 预热。", flush=True)
probe = Request("http://127.0.0.1:8008/health",
                headers={"Authorization": "Bearer " + service_env["WEBSHOP_SERVICE_TOKEN"]})
for attempt in range(180):
    if webshop_service.poll() is not None:
        raise RuntimeError(f"推理服务启动失败。请查看 {log_path}。")
    try:
        with urlopen(probe, timeout=3) as response:
            health = json.load(response)
        if (health.get("service") == "webshop-ling-planner" and health.get("ready") is True
                and health.get("adapter") is True and health.get("smoke_adapter") is False
                and health.get("model_and_config_version", {}).get("adapter_sha256")
                    == adapter_hashes["adapter_model.safetensors"]):
            print("WebShop LoRA 已就绪。请复制 VSCode Compatible URL。", flush=True)
            break
    except (URLError, TimeoutError):
        pass
    time.sleep(5)
else:
    raise TimeoutError(f"等待模型就绪超时。请查看 {log_path}。")
"""


def runtime_archive():
    data = io.BytesIO()
    def add(bundle, name, content):
        info = ZipInfo(name)
        bundle.writestr(info, content, compress_type=ZIP_DEFLATED, compresslevel=9)

    with ZipFile(data, "w") as bundle:
        files = ("training/common.py", "training/serve.py", "training/config.json", "training/requirements.txt")
        for file in files:
            add(bundle, file, (ROOT / file).read_bytes())
        with (ROOT / "data/sft/test.jsonl").open("rb") as prompts:
            add(bundle, "data/sft/test.jsonl", prompts.readline())
    return base64.b64encode(data.getvalue()).decode("ascii")


def main():
    expected = {
        "adapter_model.safetensors": FORMAL_WEIGHTS_SHA,
        "adapter_config.json": "42e16ae910929456b0ff441d626dad2fb0409979a037f777d3a1cbdce5ff4da5",
        "webshop-config.json": "309794ffda29c96c1c8860a2743bac12fdf65eab3aa181cb1f8b091db23185e3",
    }
    if FORMAL_ADAPTER.is_dir():
        for name, digest in expected.items():
            if hashlib.sha256((FORMAL_ADAPTER / name).read_bytes()).hexdigest() != digest:
                raise ValueError(f"Unexpected formal artifact: {name}")
    startup = BOOTSTRAP.replace("__ADAPTER_HASHES__", json.dumps(expected, indent=4))
    blob = runtime_archive()
    chunks = [blob[start:start + 100] for start in range(0, len(blob), 100)]
    runtime = "_webshop_runtime = (\n" + "".join(f"    {chunk!r}\n" for chunk in chunks) + ")\n"
    notebook = {
        "cells": [
            {"cell_type": "markdown", "id": "webshop-start", "metadata": {}, "source": ABOUT.splitlines(keepends=True)},
            {"cell_type": "code", "id": "webshop-runtime", "metadata": {"jupyter": {"source_hidden": True}},
             "execution_count": None, "outputs": [], "source": runtime.splitlines(keepends=True)},
            {"cell_type": "code", "id": "webshop-inference", "metadata": {},
             "execution_count": None, "outputs": [], "source": startup.splitlines(keepends=True)},
        ],
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    for cell in notebook["cells"][1:]:
        compile("".join(cell["source"]), cell["id"], "exec")
    OUTPUT.write_text(json.dumps(notebook, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(OUTPUT)


if __name__ == "__main__":
    main()
