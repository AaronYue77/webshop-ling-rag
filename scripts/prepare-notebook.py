import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
cells = []


def cell(kind, source):
    data = {"cell_type": kind, "metadata": {}, "source": source.strip().splitlines(keepends=True)}
    if kind == "code":
        data.update(execution_count=None, outputs=[])
    cells.append(data)


cell("markdown", """
# WebShop 训练与正式评测

此 Notebook 使用 Ling-3.0-tiny 和 4-bit QLoRA 训练商品任务规划器。项目源码默认从 GitHub 的 main 分支下载，也可以用 `SOURCE_INPUT` 指定已挂载的 ZIP 或目录。

在 Kaggle **Settings** 启用 GPU 和 Internet。训练使用一张 GPU，优先选择 L4 或 A100。配置、依赖和本地复现命令见 [WebShop 训练与评测指南](https://github.com/AaronYue77/webshop-ling-rag/blob/main/RECIPE.md)。
""")
cell("code", """
import os, subprocess, sys, tempfile, urllib.request, zipfile, shutil
from pathlib import Path

SOURCE = "https://github.com/AaronYue77/webshop-ling-rag/archive/refs/heads/main.zip"
SOURCE_INPUT = ""  # 可选：Kaggle 挂载的源码 ZIP 或已解压目录
WORK = Path("/kaggle/working")


def is_project_root(path):
    required = ("training/train.py", "training/requirements.txt", "data/sft/train.jsonl")
    return all((path / file).is_file() for file in required)


def find_project_root(folder):
    candidates = [path.parent.parent for path in folder.rglob("training/train.py")
                  if is_project_root(path.parent.parent)]
    if len(candidates) != 1:
        raise ValueError(f"Expected one WebShop project under {folder}, found {len(candidates)}.")
    return candidates[0]


def prepare_source(work, source_url, source_input=""):
    work.mkdir(parents=True, exist_ok=True)
    repo = work / "webshop-rag"
    if is_project_root(repo):
        return repo
    attached = Path(source_input) if source_input else None
    with tempfile.TemporaryDirectory(prefix="webshop-source-", dir=work) as temp:
        staging = Path(temp)
        if attached is not None and attached.is_dir():
            source = find_project_root(attached)
        else:
            if attached is None:
                attached = staging / "source.zip"
                urllib.request.urlretrieve(source_url, attached)
            extracted = staging / "extracted"
            with zipfile.ZipFile(attached) as archive:
                archive.extractall(extracted)
            source = find_project_root(extracted)
        shutil.copytree(source, repo, dirs_exist_ok=True)
    return repo


repo = prepare_source(WORK, SOURCE, SOURCE_INPUT)
env = {**os.environ, "CUDA_VISIBLE_DEVICES": "0", "TOKENIZERS_PARALLELISM": "false",
       "HF_HOME": "/kaggle/temp/webshop-hf"}
print("WebShop source ready:", repo, flush=True)
subprocess.run(["nvidia-smi"], check=True, env=env)
subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(repo / "training" / "requirements.txt")], env=env, check=True)
""")
cell("markdown", """
## 训练

先用 `MODE = "smoke"` 检查 GPU 环境，再切换到 `MODE = "train"`。正式训练用 1,246 条样本进行一轮 QLoRA。续训时填写检查点路径并沿用原有底座版本。
""")
cell("code", """
MODE = "smoke"   # "smoke" 或 "train"
RESUME = ""      # 例："/kaggle/input/.../checkpoints/checkpoint-20"
MODEL_SHA = "9a98e35fe1c9ee255f78dd64771c7ae15a799481"
assert MODE in {"train", "smoke"}
if MODEL_SHA:
    env["WEBSHOP_MODEL_REVISION"] = MODEL_SHA
out = WORK / ("smoke-run" if MODE == "smoke" else "webshop-run")
if RESUME and not (out / "run-config.json").exists():
    old_run = Path(RESUME).resolve().parents[1]
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy2(old_run / "run-config.json", out / "run-config.json")
command = [sys.executable, "training/train.py", "--output", str(out)]
if MODE == "smoke":
    command += ["--smoke"]
if RESUME:
    command += ["--resume", RESUME]
if not (out / "adapter" / "webshop-config.json").exists():
    if MODE == "train" and not RESUME:
        probe = '''from common import DATA, generate, load_base, model_config, read_rows
config = model_config()
model, tokenizer, _ = load_base(config)
sample = read_rows(DATA / "test.jsonl")[0]
raw = generate(model, tokenizer, sample["messages"][:-1], {**config, "max_new_tokens": 12})
if not raw.strip():
    raise RuntimeError("The generation preflight returned no text.")
print("Ling generation preflight passed.", flush=True)
'''
        subprocess.run([sys.executable, "-c", probe], cwd=repo / "training", env=env, check=True)
    subprocess.run(command, cwd=repo, env=env, check=True)
""")
cell("markdown", """
## 正式评测

基座与 LoRA 使用同一批 156 道留出题。评测逐题写盘，可用相同配置续跑。结果保存在 `/kaggle/working/`。[查看正式测试报告](https://github.com/AaronYue77/webshop-ling-rag/blob/main/docs/results/test/per-question.md)
""")
cell("code", """
for split in ["test"]:
    command = [sys.executable, "training/evaluate.py", "--adapter", str(out / "adapter"),
               "--output", str(out / ("evaluation-" + split)), "--split", split]
    if MODE == "smoke":
        command += ["--limit", "4"]
    subprocess.run(command, cwd=repo, env=env, check=True)
shutil.make_archive(str(WORK / ("webshop-smoke-assets" if MODE == "smoke" else "webshop-lora-assets")), "zip", out)
""")
cell("markdown", """
## 推理与问答

Windows 问答台请使用[独立推理 Notebook](https://www.kaggle.com/code/aaronyue77/webshop-ling-inference)，启动和连接步骤见该页面。

下方单元用于单独调试推理 API。先运行环境准备单元并挂载训练产物。挂载多个适配器时，用 `ADAPTER` 指定目录。将服务令牌保存到 Kaggle Secret `WEBSHOP_SERVICE_TOKEN`，再将 `SERVE` 设为 `True`。
""")
cell("code", """
SERVE = False
ADAPTER = ""  # 可填写指定的适配器目录
if SERVE:
    from kaggle_secrets import UserSecretsClient
    import json, re, time, urllib.error
    local_output = globals().get("out", WORK / "webshop-run")
    if not ADAPTER:
        candidates = [local_output / "adapter" / "webshop-config.json"]
        candidates += list(Path("/kaggle/input").rglob("adapter/webshop-config.json"))
        candidates = [path for path in candidates if path.is_file()]
        if len(candidates) != 1:
            raise ValueError("Specify ADAPTER when there is no unique saved adapter.")
        ADAPTER = str(candidates[0].parent)
    service_env = {**env, "WEBSHOP_SERVICE_TOKEN": UserSecretsClient().get_secret("WEBSHOP_SERVICE_TOKEN")}
    server_log = WORK / "webshop-inference-process.log"
    with server_log.open("w") as stream:
        serving = subprocess.Popen([sys.executable, "training/serve.py", "--adapter", ADAPTER,
                                    "--log", str(WORK / "webshop-inference.jsonl")], cwd=repo, env=service_env,
                                    stdout=stream, stderr=subprocess.STDOUT)
    health_request = urllib.request.Request("http://127.0.0.1:8008/health",
                                            headers={"Authorization": "Bearer " + service_env["WEBSHOP_SERVICE_TOKEN"]})
    for _ in range(180):
        if serving.poll() is not None:
            raise RuntimeError(server_log.read_text()[-3000:])
        try:
            with urllib.request.urlopen(health_request, timeout=3) as response:
                if json.load(response).get("ready"):
                    break
        except urllib.error.URLError:
            pass
        time.sleep(5)
    else:
        raise TimeoutError("Model warm-up timed out. See webshop-inference-process.log.")
    cloudflared = Path("/kaggle/temp/cloudflared")
    if not cloudflared.exists():
        cloudflared.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", cloudflared)
        cloudflared.chmod(0o755)
    tunnel_log = Path("/kaggle/temp/webshop-tunnel.log")
    with tunnel_log.open("w") as stream:
        tunnel = subprocess.Popen([str(cloudflared), "tunnel", "--no-autoupdate", "--protocol", "http2",
                                   "--url", "http://127.0.0.1:8008"], stdout=stream, stderr=subprocess.STDOUT)
    for _ in range(45):
        match = re.search(r"https://[a-z0-9-]+[.]trycloudflare[.]com", tunnel_log.read_text())
        if match:
            print("Windows 推理 API URL:", match.group())
            print("模型已就绪。请在 Windows 网页使用此地址验证连接。")
            break
        if tunnel.poll() is not None or serving.poll() is not None:
            raise RuntimeError("查看 Notebook 输出和 inference.jsonl 以定位服务启动失败。")
        time.sleep(2)
    else:
        raise TimeoutError("临时通道未建立。检查 Kaggle Internet / 出站端口，或使用可访问的等效 HTTPS 反向代理。")
""")
notebook = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
             "language_info": {"name": "python", "version": "3.12"}}, "nbformat": 4, "nbformat_minor": 4}
(ROOT / "kaggle" / "webshop-ling-rag.ipynb").write_text(json.dumps(notebook, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
