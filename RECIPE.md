# WebShop 训练与评测指南

本页记录 Ling-3.0-tiny LoRA 的训练设置、评测命令和适配器来源。Windows 问答台使用方法见[快速开始](README.md#快速开始)。

## 运行环境与训练配置

正式运行使用 Kaggle T4 × 2 实例中的一张 GPU，采用 Transformers、PEFT 与 bitsandbytes 的 4-bit NF4 QLoRA。底座为 `inclusionAI/Ling-3.0-tiny`，固定版本见下方命令。LoRA rank 8、alpha 16、dropout 0.05，学习率 0.00015，梯度累积 16 步，序列长度 1152，训练一轮。依赖和注意力投影层清单见[依赖文件](training/requirements.txt)与[训练配置](training/config.json)。

**Kaggle 训练**。导入[训练 Notebook](kaggle/webshop-ling-rag.ipynb)，启用 GPU 和 Internet。源码由 Notebook 下载并自动解压定位。先运行 `smoke`，再切换到 `train`。也可通过 `SOURCE_INPUT` 指定已挂载的源码 ZIP 或目录。

## 复现命令

在 Linux CUDA 环境或 Kaggle Notebook 中从项目根目录执行。

~~~bash
python -m pip install -r training/requirements.txt
export CUDA_VISIBLE_DEVICES=0
export WEBSHOP_MODEL_REVISION=9a98e35fe1c9ee255f78dd64771c7ae15a799481
python training/train.py --smoke --output runs/smoke
python training/train.py --output runs/webshop
python training/evaluate.py --adapter runs/webshop/adapter --split test --output runs/webshop/test
~~~

`WEBSHOP_MODEL_REVISION` 固定为正式训练所用版本。更换模型版本、适配器或数据后，请为评测指定新的输出目录。

## 推理样例

连接后，Ling 在 Kaggle 上先理解问题并生成计划。问答台召回候选并提供目录证据，Ling 按原问题核选商品并生成连贯的回答。[输入与回答格式](docs/ANSWER-FORMAT.md)

设置环境变量 WEBSHOP_SERVICE_TOKEN 为至少 24 位的 ASCII 令牌。从下面的 Release 下载三个文件到同一目录，例如 `runs/webshop/adapter`，再启动服务。

~~~bash
python training/serve.py --adapter runs/webshop/adapter --port 8008
~~~

独立 API 的开发测试可向 /v1/plan 发送带 Bearer 令牌的 JSON POST。

~~~json
{"question":"找 50 美元以内的 8.5 码女士鞋，给图片、历史价格和颜色。","context":{"previousResults":[]}}
~~~

预期计划包含 search、女士鞋、US 8.5、预算上限 50，以及图片、目录价、历史价格、尺码和颜色任务。输入和输出字段由 web/policy.js 定义，测试样本可直接读取 data/sft/。

## 权重、数据与评测

| 资料 | 位置 |
|---|---|
| LoRA 权重 | [adapter_model.safetensors](https://github.com/AaronYue77/webshop-ling-rag/releases/download/v1.0.0/adapter_model.safetensors) |
| 适配器配置 | [adapter_config.json](https://github.com/AaronYue77/webshop-ling-rag/releases/download/v1.0.0/adapter_config.json) · [webshop-config.json](https://github.com/AaronYue77/webshop-ling-rag/releases/download/v1.0.0/webshop-config.json) |
| 训练、验证及测试数据 | [数据清单](data/sft/manifest.json) · [ASIN 分组](data/sft/asin-splits.json) |
| 评测材料 | [正式测试报告](docs/results/test/per-question.md) · [评测脚本](training/evaluate.py) · [逐题 TXT 回放](LOGS.md#逐题-txt) |

正式 `adapter_model.safetensors` 的 SHA-256 为 `a12308ed323e764e3a14fb3437a9371e8d839394cfa27f134e9db65c2e86b8c9`。

正式训练运行一轮、78 个优化步骤，平均训练损失为 0.0290。[Kaggle 正式训练产物](https://www.kaggle.com/code/aaronyue77/webshop-ling-rag/output?scriptVersionId=372062430)

## 数据准备

数据按 ASIN 家族和近重复分组，训练、验证和测试分别有 1,246、156 和 156 条题目。测试使用留出的问句模板。

重建商品目录时，先将 WebShop 原始导出放到 `data/webshop-779.json`，运行 `node scripts/prepare-catalog.cjs`。重建问答样本运行 `node scripts/prepare-dataset.cjs`。

## AI 辅助记录

ChatGPT 协助编写任务规划、检索、训练脚本和 Windows 页面，并生成训练问题和回归测试。
