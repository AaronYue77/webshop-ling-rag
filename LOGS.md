# 运行与问题日志

本页记录 Kaggle 的已核对结果、日志字段及还原逐题验证的方法。

## 对话自动存档

通过 Windows 的 `启动问答.cmd` 打开问答台时，发出的提问和随后收到的回答会写入项目中的 `logs/conversations.json`。存档包含对话正文、目录依据、模型计划、耗时和用于继续追问的上下文。再次打开可从左侧「最近对话」接着聊。此前用同一浏览器在问答台地址保存的记录会在启动时同步。直接打开单页时，对话保存在浏览器中。

## 逐题 TXT

在左侧「最近对话」右键选中一条记录，选择「导出对话记录」，即可下载该对话的 `webshop-conversation-<对话ID>.txt`。触屏可点击记录旁的「⋯」。TXT 使用 UTF-8，每行一个 JSON 对象。有标准任务计划的数据集例题，可在项目根目录运行：

```powershell
node scripts/audit-questions.cjs
node scripts/audit-questions.cjs --run runs/webshop-run
```

第一条生成 `runs/audit/local-questions.txt`，覆盖训练、验证、测试和挑战题。第二条读取已下载并解压到 `runs/webshop-run` 的 Kaggle 产物，核对分组和数据哈希后，生成 `runs/audit/kaggle-questions.txt`。正式测试和挑战题分别保留基座与微调两条记录。评测只按已有逐题预测回放任务计划，无需再次运行 GPU。可用 `--split test` 选择单组，或用 `--output 路径` 指定文件名。

| 字段 | 记录口径 |
|---|---|
| `question_id`、`question` | 数据集 ID 或网页对话生成的 ID，以及原问题 |
| `reference_answer`、`reference_evidence_pages` | 用数据集标准任务计划按当前目录生成的参考回答和 ASIN 来源。一般网页对话的参考字段为 `null`。 |
| `recalled_pages` | 实际取用的结果排序、ASIN、来源 URL 和检索分。按序号查询的记录保留原清单位置。 |
| `model_answer`、`model_output`、`output_citations` | 展示或回放的完整回答、模型原始输出或结构化计划、回答引用的商品及证据字段 |
| `retrieval_ms`、`generation_ms` | 毫秒。检索计时涵盖筛选、排序或序号定位。生成计时来自模型推理端。本地规则和未记录单独生成耗时的旧版结果用 `null`。 |
| `model_and_config_version` | 模型版本、适配器或配置哈希，以及有记录时的目录版本 |

旧版 Kaggle 预测的生成与解析合计耗时保存在 `legacy_generation_and_parse_ms`。本地回放的检索耗时按回放时重新测量，`answer_mode` 标明实际执行或回退方式。尚无预测的题标为 `pending`。参考答案用于核对当前目录下的任务执行，数据集提供的是标准计划，人工独立标注的商品排名仍为空。

## Kaggle 运行记录

| 运行 | 已核对的结果 |
|---|---|
| 冒烟测试 `372056035` | 单步 QLoRA 损失 0.1205，输出了冒烟适配器。4 道评测题遇到生成接口拒收 `token_type_ids`，旧报告中的零分不能用于衡量模型效果。 |
| 正式训练 `372062430` | 已完成一轮训练及 360 次对照生成，训练平均损失 0.0290。已校验 ZIP、适配器与两组数据哈希。两组聚合报告见[正式测试](docs/results/test/comparison.json)和[挑战题](docs/results/challenge/comparison.json)。按上文命令可从评测输出生成逐题记录。 |

| 指标 | 测试集 156 题（基座 → LoRA） | 挑战题 24 题（基座 → LoRA） |
|---|---:|---:|
| 任务宏 F1 | 29.58% → 90.04% | 20.60% → 71.48% |
| 约束完全匹配 | 55.13% → 96.15% | 29.17% → 54.17% |
| 完整计划匹配 | 0% → 76.92% | 0% → 25.00% |

指标来自格式严格的任务规划评测。正式评测的原始逐题文件仅记录生成及解析总耗时。在线推理接口记录独立生成耗时，并兼容大于 0 且不超过 300 的数字尺码。

底座版本为 `9a98e35fe1c9ee255f78dd64771c7ae15a799481`。训练只使用一张 GPU，Kaggle 运行环境配有两张 T4。下列运行页面需对应 Kaggle 账号访问。

- [正式训练日志](https://www.kaggle.com/code/aaronyue77/webshop-ling-rag?scriptVersionId=372062430)
- [正式产物与对照报告](https://www.kaggle.com/code/aaronyue77/webshop-ling-rag/output?scriptVersionId=372062430)
- [冒烟测试输出](https://www.kaggle.com/code/aaronyue77/webshop-ling-rag/output?scriptVersionId=372056035)

| 事件 | 处置 |
|---|---|
| 原始目录将一款男鞋归入女士鞋路径 | 结合标题、Department 和鞋履路径确认适用人群 |
| 缺失的选项价存在数值 0 | 以有效 price_string 作为独立选项价，缺价写 null |
| 价格没有采集日期 | 页面标为目录快照价，历史趋势与现价单独说明 |
| 变体与相近标题可能跨数据组 | 用选项 ASIN、规范化标题和相似度分组后再分层 |
| 原始型号可能误导兼容推荐 | 区分目录兼容线索、明确不兼容与需要复核三种状态 |
| Kaggle API 请求超时或计划格式不合格 | 网页回退到本地规划，将问题和处理结果写入对话日志 |
| 冒烟评测触发 `token_type_ids` 兼容错误 | 禁止 tokenizer 添加该字段。更新后的评测脚本只将已生成文本的格式错误计入指标，生成调用失败时保留此前的逐题记录并停止。 |

| 日志 | 内容 |
|---|---|
| 网页导出的 webshop-conversation-<对话ID>.txt | 与批量评测统一的逐题记录，包含所选对话、引用、耗时及回退事件 |
| runs/…/logs/training.jsonl | 数据哈希、底座版本、依赖版本、GPU、损失、检查点和异常 |
| runs/…/evaluation-*/comparison.json | 基座与适配器同口径指标及差值 |
| runs/…/evaluation-*/\*-predictions.jsonl | 每条的标准计划、生成计划、耗时和解析结果 |
| runs/…/logs/inference.jsonl | 推理服务就绪、耗时、错误与回退处理 |

网页导出的日志可包含用户输入。训练日志和推理服务日志在各自运行时生成，公开仓库包含验证材料及日志说明。
