# Ling-3.0-tiny 商品问答 Recipe

对应 [Ling Cookbook Issue #11](https://github.com/inclusionAI/ling-cookbook/issues/11)，拟放入 `guide/finetuning/ling-3.0-tiny/webshop-rag/`。训练模型读取问题和对话上下文，输出结构化计划。检索端根据商品字段完成证据核验与回答。

## 运行环境与训练配置

正式运行使用 Kaggle T4 × 2 实例中的一张 GPU，采用 Transformers、PEFT 与 bitsandbytes 的 4-bit NF4 QLoRA。底座为 `inclusionAI/Ling-3.0-tiny`，固定版本见下方命令。LoRA rank 8、alpha 16、dropout 0.05，学习率 0.00015，梯度累积 16 步，序列长度 1152，训练一轮。依赖和注意力投影层清单见[依赖文件](training/requirements.txt)与[训练配置](training/config.json)。

**Windows 快速开始**。**Code → Download ZIP → 解压 → 双击启动问答.cmd**。[源码 ZIP](https://github.com/AaronYue77/webshop-ling-rag/archive/refs/heads/main.zip)

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

上面的 WEBSHOP_MODEL_REVISION 与本次 Kaggle 正式训练一致。复现其他运行时，使用对应训练日志里的模型 commit。底座与 LoRA 使用相同的评测输入。按题族检查指标，额外核对引用位置、候选 ASIN、快照与实时价格的表述。用更新后的评测脚本重测旧版结果时，选择新的输出目录，以免复用旧版记录。

## 推理样例

设置环境变量 WEBSHOP_SERVICE_TOKEN 为至少 24 位的 ASCII 令牌。从下面的 Release 下载三个文件到同一目录，例如 `runs/webshop/adapter`，再启动服务。

~~~bash
python training/serve.py --adapter runs/webshop/adapter --port 8008
~~~

独立 API 的开发测试可向 /v1/plan 发送带 Bearer 令牌的 JSON POST。

Windows 问答使用 [Kaggle 一键推理 Notebook](https://www.kaggle.com/code/aaronyue77/webshop-ling-inference)。**Kaggle Copy & Edit → Run All → 复制 VSCode Compatible URL**。创建副本后确认 GPU 和 Internet 已开启。看到模型就绪后，从 **Run → Kaggle Jupyter Server** 复制 **VSCode Compatible URL**，粘贴到问答台。也可导入[仓库版一键推理 Notebook](kaggle/webshop-ling-inference.ipynb)，它会从 GitHub Release 下载并核对正式权重。

~~~json
{"question":"找 50 美元以内的 8.5 码女士鞋，给图片、历史价格和颜色。","context":{"previousResults":[]}}
~~~

预期计划包含 search、女士鞋、US 8.5、预算上限 50，以及图片、目录价、历史价格、尺码和颜色任务。输入和输出字段由 web/policy.js 定义，测试样本可直接读取 data/sft/。

## 权重、数据与评测

| 资料 | 位置 |
|---|---|
| LoRA 权重 | [adapter_model.safetensors](https://github.com/AaronYue77/webshop-ling-rag/releases/download/v1.0.0/adapter_model.safetensors) |
| 适配器配置 | [adapter_config.json](https://github.com/AaronYue77/webshop-ling-rag/releases/download/v1.0.0/adapter_config.json) · [webshop-config.json](https://github.com/AaronYue77/webshop-ling-rag/releases/download/v1.0.0/webshop-config.json) |
| 训练、验证及评测数据 | [GitHub data/sft](https://github.com/AaronYue77/webshop-ling-rag/tree/main/data/sft) · [ASIN 分组](data/sft/asin-splits.json) |
| 正式测试集实测指标 | [comparison.json](https://github.com/AaronYue77/webshop-ling-rag/blob/main/docs/results/test/comparison.json) |
| 评测与回放 | [评测脚本](training/evaluate.py) · [逐题日志说明](LOGS.md#逐题-txt) |

正式 `adapter_model.safetensors` 的 SHA-256 为 `a12308ed323e764e3a14fb3437a9371e8d839394cfa27f134e9db65c2e86b8c9`。

## 正式训练结果

正式训练跑完 1 个 epoch、78 个优化步骤，训练平均损失为 0.0290。下表是严格检查结构化任务计划后的模型对照。

| 数据集 | 每模型题数 | 基座任务宏 F1 | LoRA 任务宏 F1 | LoRA 完整计划匹配 |
|---|---:|---:|---:|---:|
| 测试集 | 156 | 29.58% | 90.04% | 120/156 |

训练按 ASIN 家族隔离，正式测试使用留出模板。基座和 LoRA 各生成 156 条计划，共 312 次。评测计算有效 JSON 比例、任务宏 F1、约束完全匹配和完整计划匹配，并保存每条的参考计划、生成计划和解析状态。评测输出可通过回放脚本逐题核对。[正式测试 156 题完整题目](docs/formal-test-questions.md) · [逐题文件与字段说明](LOGS.md#逐题-txt)

## AI 辅助记录

ChatGPT 协助编写任务规划、检索、训练脚本和 Windows 页面，并生成训练问题和回归测试。数据按 ASIN 家族隔离，另用留出句式核对规划结果。Kaggle 的实际运行日志用于确认模型兼容性，并定位了冒烟评测中的 tokenizer 参数错误。
