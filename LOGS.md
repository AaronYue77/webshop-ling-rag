# 运行与问题日志

## 对话自动存档

通过 Windows 的 `启动问答.cmd` 打开问答台时，对话正文、目录依据、模型计划、耗时和追问上下文会写入 `logs/conversations.json`。直接打开单页时，对话保存在浏览器中。可在左侧「最近对话」继续对话。

## 逐题 TXT

在「最近对话」中右键选择「导出对话记录」，触屏可点击记录旁的「⋯」。导出文件 `webshop-conversation-<对话ID>.txt` 使用 UTF-8，每行一个 JSON 对象，可能含用户输入。

在项目根目录执行以下命令，可导出数据集记录或回放已下载的正式评测产物。

```powershell
node scripts/audit-questions.cjs
node scripts/audit-questions.cjs --run runs/webshop-run --split test
```

第一条写入 `runs/audit/local-questions.txt`。第二条读取解压到 `runs/webshop-run` 的正式产物、核对数据哈希，并将每题的基座和 LoRA 记录写入 `runs/audit/kaggle-questions.txt`。回放无需重新运行 GPU。可用 `--output` 指定文件名。

| 字段 | 记录口径 |
|---|---|
| `question_id`、`question` | 问题标识与原问题 |
| `reference_answer`、`reference_evidence_pages` | 由标准任务计划和目录生成的参考回答及证据，普通网页对话通常为空 |
| `recalled_pages` | 实际召回的 ASIN、顺序、来源与检索分 |
| `model_answer`、`model_output`、`output_citations` | 展示或回放的回答、模型输出与商品证据引用 |
| `retrieval_ms`、`generation_ms` | 检索与生成耗时，单位为毫秒。缺少独立生成计时的旧评测记录中，`legacy_generation_and_parse_ms` 保存生成与解析的合计耗时 |
| `model_and_config_version`、`answer_mode` | 模型与配置版本、实际执行或回放方式 |

公开评分和模型输出见[正式测试报告](docs/results/test/per-question.md)。

## Kaggle 运行记录

| 资料 | 位置 |
|---|---|
| 正式训练 `372062430` | [运行页面](https://www.kaggle.com/code/aaronyue77/webshop-ling-rag?scriptVersionId=372062430) · [训练产物](https://www.kaggle.com/code/aaronyue77/webshop-ling-rag/output?scriptVersionId=372062430) |
| 训练日志 | `runs/…/logs/training.jsonl`，记录数据哈希、依赖、GPU、损失与检查点 |
| 评测产物 | `runs/…/evaluation-test/comparison.json` 和 `*-predictions.jsonl`，保存汇总指标、标准计划、模型输出与解析状态 |
| 在线推理诊断 | [日志位置与失败字段](docs/ANSWER-FORMAT.md#回答失败诊断) |

推理连接或输出校验失败时，问答台显示失败原因和重试入口，并保留查询记录。
