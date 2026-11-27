"""Build the inference-only Kaggle notebook from the local WebShop runtime."""
import base64
import hashlib
import io
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "kaggle/webshop-ling-inference.ipynb"
FORMAL_ADAPTER = ROOT / "runs/webshop-run/adapter"
FORMAL_WEIGHTS_SHA = "a12308ed323e764e3a14fb3437a9371e8d839394cfa27f134e9db65c2e86b8c9"
ABOUT = """# WebShop Ling-3.0-tiny LoRA Inference

[打开 GitHub 项目](https://github.com/AaronYue77/webshop-ling-rag) · [下载 Windows 问答台（ZIP）](https://github.com/AaronYue77/webshop-ling-rag/archive/refs/heads/main.zip)

下载并解压后，双击 `启动问答.cmd` 打开问答台。
此 Notebook 在 Kaggle 上运行 Ling LoRA，负责理解问题、按目录证据核选商品并生成连贯的回答。请搭配同版本的 Windows 问答台。

1. 点 **Copy & Edit** 打开自己的副本。
2. 在 **Settings** 启用 **Internet**，将 **Accelerator** 设为 GPU，随后点 **Run All**。
3. 等待输出 **WebShop LoRA 已就绪**。进入 **Run → Kaggle Jupyter Server**，复制 **VSCode Compatible URL**，粘贴到 WebShop 问答台。问答期间保持会话运行。

运行时会显示当前步骤和已用时间。模型下载显示已完成的文件数，加载时显示已完成的权重分片数。采集到进度后会估算当前步骤的剩余时间，首次启动会受网络速度影响。

正式 LoRA 来自[训练产物](https://www.kaggle.com/code/aaronyue77/webshop-ling-rag/output?scriptVersionId=372062430)，也可从 [GitHub Release](https://github.com/AaronYue77/webshop-ling-rag/releases/tag/v1.0.0) 获取。
"""

BOOTSTRAP = r"""from pathlib import Path
import base64
from contextlib import contextmanager
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
from threading import Event, Thread
import time
from urllib.error import URLError
from urllib.request import Request, urlopen
from zipfile import ZipFile

import torch

if not torch.cuda.is_available():
    raise RuntimeError("在 Settings → Accelerator 选择 GPU，再点击 Run All。")

work = Path("/kaggle/working")
repo = work / "webshop-inference"
output_handle = "aaronyue77/webshop-ling-rag/versions/3"
release = "https://github.com/AaronYue77/webshop-ling-rag/releases/download/v1.0.0"
adapter_hashes = __ADAPTER_HASHES__
started = time.monotonic()


def duration(seconds):
    minutes, seconds = divmod(max(0, round(seconds)), 60)
    return f"{minutes}分{seconds:02d}秒" if minutes else f"{seconds}秒"


def status(message):
    print(f"[已用 {duration(time.monotonic() - started)}] {message}", flush=True)


@contextmanager
def waiting(message):
    status(message)
    done = Event()

    def heartbeat():
        while not done.wait(20):
            status(message + "（仍在进行）")

    worker = Thread(target=heartbeat, daemon=True)
    worker.start()
    try:
        yield
    finally:
        done.set()
        worker.join()


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
            status("已找到挂载的正式 LoRA，校验通过。")
            return config.parent

    adapter = work / "webshop-formal-adapter"
    if matches_formal_adapter(adapter):
        status("正在使用已校验的 LoRA 缓存。")
        return adapter
    adapter.mkdir(parents=True, exist_ok=True)
    try:
        try:
            from kagglehub import notebook_output_download
        except ImportError:
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "kagglehub"], check=True)
            from kagglehub import notebook_output_download
        archive = Path(notebook_output_download(output_handle, path="webshop-lora-assets.zip"))
        if archive.is_dir():
            archive = archive / "webshop-lora-assets.zip"
        with ZipFile(archive) as bundle:
            for name in adapter_hashes:
                with bundle.open(f"adapter/{name}") as source, (adapter / name).open("wb") as target:
                    shutil.copyfileobj(source, target)
    except (ImportError, OSError, RuntimeError, subprocess.CalledProcessError, KeyError) as error:
        status(f"Kaggle 训练产物暂不可用（{type(error).__name__}），尝试 GitHub Release。")
        for name in adapter_hashes:
            with urlopen(f"{release}/{name}", timeout=60) as source, (adapter / name).open("wb") as target:
                shutil.copyfileobj(source, target)
    if not matches_formal_adapter(adapter):
        raise RuntimeError("正式权重完整性校验失败。请重启 Kaggle 会话后再试。")
    status("正式 LoRA 校验通过。")
    return adapter


with waiting("第 1/6 步：获取并校验正式 LoRA"):
    adapter = load_adapter()
repo.mkdir(parents=True, exist_ok=True)
with ZipFile(io.BytesIO(base64.b64decode(_webshop_runtime))) as runtime:
    runtime.extractall(repo)

with waiting("第 2/6 步：安装或检查推理依赖"):
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
# 仅排查时开启，失败输出写入 /kaggle/temp 下的私有临时目录。
CAPTURE_INVALID_MODEL_OUTPUT = False
service_env = {
    **os.environ,
    "WEBSHOP_SERVICE_TOKEN": secrets.token_urlsafe(32),
    "WEBSHOP_CAPTURE_INVALID_OUTPUT": "1" if CAPTURE_INVALID_MODEL_OUTPUT else "0",
    "CUDA_VISIBLE_DEVICES": "0",
    "TOKENIZERS_PARALLELISM": "false",
    "HF_HOME": "/kaggle/temp/webshop-hf",
    "WEBSHOP_STARTUP_PROGRESS": "1",
    "HF_HUB_DISABLE_PROGRESS_BARS": "0",
    "TQDM_MININTERVAL": "2",
}
stages = {
    "download": "第 3/6 步：下载或检查基座模型缓存",
    "load": "第 4/6 步：将基座权重加载到 GPU",
    "adapter": "第 5/6 步：加载 LoRA 适配器",
    "warmup": "第 6/6 步：GPU 预热与服务健康检查",
}
progress_pattern = re.compile(r"\b(Fetching \d+ files|Loading checkpoint shards):\s*\d+%\|.*?\|\s*(\d+)/(\d+)\s*\[([^]]+)\]")
log_path = work / "webshop-inference-start.log"
with log_path.open("w", encoding="utf-8") as log:
    webshop_service = subprocess.Popen(
        [sys.executable, "training/serve.py", "--adapter", str(adapter), "--log", str(work / "webshop-inference.jsonl")],
        cwd=repo, env=service_env, stdout=log, stderr=subprocess.STDOUT,
    )

def wait_until_ready():
    probe = Request("http://127.0.0.1:8008/health",
                    headers={"Authorization": "Bearer " + service_env["WEBSHOP_SERVICE_TOKEN"]})
    step = "正在启动推理进程"
    phase = None
    deadline = time.monotonic() + 25 * 60
    last_update = time.monotonic()
    percent_seen = -10
    status(step)
    with log_path.open(encoding="utf-8", errors="replace") as log:
        while time.monotonic() < deadline:
            for line in log:
                if line.startswith("WEBSHOP_STARTUP "):
                    phase = line.split()[1]
                    step = stages[phase]
                    status(step)
                    last_update = time.monotonic()
                    percent_seen = -10
                progress = progress_pattern.search(line)
                if not progress:
                    continue
                label, completed, total, timings = progress.groups()
                completed, total = int(completed), int(total)
                if not total:
                    continue
                percent = 100 * completed // total
                if percent < percent_seen + 10 and not (percent == 100 and percent_seen < 100):
                    continue
                unit = "模型文件" if label.startswith("Fetching") else "权重分片"
                remaining = re.search(r"<([\d:]+)(?:,|$)", timings)
                eta = f"，预计剩余 {remaining[1]}" if 0 < percent < 100 and remaining else ""
                status(f"{unit} {completed}/{total}（{percent}%）{eta}")
                percent_seen = percent
                last_update = time.monotonic()
            if webshop_service.poll() is not None:
                raise RuntimeError(f"推理服务启动失败。请查看 {log_path}。")
            try:
                with urlopen(probe, timeout=3) as response:
                    health = json.load(response)
                if (health.get("service") == "webshop-ling-planner" and health.get("ready") is True
                        and health.get("adapter") is True and health.get("smoke_adapter") is False
                        and health.get("model_and_config_version", {}).get("planner_protocol") == 4
                        and health.get("model_and_config_version", {}).get("adapter_sha256")
                            == adapter_hashes["adapter_model.safetensors"]):
                    status("WebShop LoRA 已就绪。请复制 VSCode Compatible URL。")
                    return
            except (URLError, TimeoutError):
                pass
            if phase != "warmup" and time.monotonic() - last_update >= 20:
                status(step + "（仍在进行）")
                last_update = time.monotonic()
            time.sleep(2)
    raise TimeoutError(f"等待模型就绪超时。请查看 {log_path}。")


try:
    wait_until_ready()
except BaseException:
    if webshop_service.poll() is None:
        webshop_service.terminate()
    raise
"""


def runtime_archive():
    data = io.BytesIO()
    with ZipFile(data, "w", ZIP_DEFLATED, compresslevel=9) as bundle:
        files = ("training/common.py", "training/serve.py", "training/config.json", "training/requirements.txt")
        for file in files:
            bundle.writestr(file, (ROOT / file).read_bytes())
        with (ROOT / "data/sft/test.jsonl").open("rb") as prompts:
            bundle.writestr("data/sft/test.jsonl", prompts.readline())
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
