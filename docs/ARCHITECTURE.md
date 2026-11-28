# WebShop RAG 项目架构图

Windows 问答台负责目录检索和展示。Kaggle 上的 Ling-3.0-tiny LoRA 负责理解问题、规划任务、核选商品与生成正文。下面按执行顺序展开连接、查询与回答，并给出正式训练和评测的复现入口。

[启动与连接](#启动与连接) · [问答执行](#问答执行) · [核选与回答](#核选与回答) · [训练、评测与推理](#训练评测与推理)

## 启动与连接

```mermaid
flowchart TD
  subgraph KAGGLE["Kaggle GPU 会话"]
    START["复制推理 Notebook · 开启 GPU 和 Internet · Run All"] --> SOURCE{"已有通过校验的正式 LoRA？"}
    SOURCE -->|挂载产物或缓存可用| LOAD["安装或检查依赖"]
    SOURCE -->|需要获取| FETCH["获取固定版本的 Kaggle 训练产物"]
    FETCH -->|已取得| HASH{"权重和配置 SHA-256 通过？"}
    FETCH -->|获取失败| RELEASE["从 GitHub Release 下载正式适配器"]
    RELEASE --> HASH
    HASH -->|是| LOAD
    HASH -->|否| STOP["启动停止，查看 Notebook 输出或启动日志"]
    LOAD --> GPU["下载或复用基座缓存，加载基座与 LoRA"]
    GPU --> HEALTH{"GPU 预热与服务自检通过？"}
    HEALTH -->|是| URL["提示就绪，复制 VSCode Compatible URL"]
    HEALTH -->|进程退出或超时| STOP
  end

  subgraph WINDOWS["Windows 问答台"]
    OPEN["启动问答台，载入浏览器目录"] --> CONNECT["粘贴会话地址，定位 Jupyter 内核"]
    CONNECT --> PROBE{"正式适配器就绪且协议兼容？"}
    PROBE -->|是| READY["进入联网问答"]
    PROBE -->|否| FIX["保留待发问题，提示使用匹配的会话"]
    FIX -->|重新连接| CONNECT
  end

  URL --> CONNECT

  style KAGGLE fill:none,stroke:#8b949e,stroke-dasharray:4 3
  style WINDOWS fill:none,stroke:#8b949e,stroke-dasharray:4 3
```

Windows 启动器经本地转发器连接 Kaggle Jupyter 通道，内核再访问会话内的 FastAPI。Notebook 自检会校验协议 4 和正式权重哈希，问答台检查服务已就绪、已启用正式适配器且支持所需协议。[转发器](../web/relay.cs) · [连接校验](../web/app.js) · [公开推理 Notebook](https://www.kaggle.com/code/aaronyue77/webshop-ling-inference)

## 问答执行

```mermaid
flowchart TD
  INPUT["原问题 + 上一轮问题、商品序号与当前商品"] --> SESSION{"会话已连接？"}
  SESSION -->|否| PENDING["保留问题，打开连接设置"]
  SESSION -->|是| PLAN["/v1/plan · Ling 识别意图、任务与条件"]
  PLAN --> CHECK{"服务端校验计划"}
  CHECK -->|动作枚举无效| REPAIR["让 Ling 在三种动作中重选"]
  CHECK -->|其他格式问题| RETRY["在时间允许时补充格式要求并重试"]
  REPAIR --> RECHECK{"修复或重试后通过？"}
  RETRY --> RECHECK
  RECHECK -->|否| FAILED["保留问题与错误，显示重试入口"]
  RECHECK -->|是| ROUTE{"浏览器校验并执行 action"}
  CHECK -->|通过| ROUTE

  ROUTE -->|search| FILTER["按类目、受众、颜色、尺码、预算、型号或术语过滤"]
  FILTER --> RANK["BM25 排序与目录证据打分"]
  ROUTE -->|detail| DETAIL["从已展示清单按序号找 ASIN，读取详情字段"]
  ROUTE -->|compare| COMPARE["按序号找多款，比较同口径价格、规格和属性"]
  DETAIL --> REF{"可定位所指商品？"}
  COMPARE --> REF
  REF -->|找不到或未指定| CONTEXT["记录序号缺口或请用户明确所指商品"]
  REF -->|有可定位商品| PACK["打包候选字段、目录原文与缺失项"]
  CONTEXT --> PACK
  RANK --> PACK
  PACK --> NEXT["将原问题与目录证据交给 /v1/answer"]
```

| 路由 | 执行方式与证据口径 |
|---|---|
| `search` | 从标准化目录召回候选。明确尺码优先用可核实的选项价，缺少选项价时标明所用商品快照价。型号兼容性按目录证据判断。 |
| `detail` | 使用上一轮展示编号定位商品。按需提供材质、颜色、尺码、规格和可核实的选项信息。 |
| `compare` | 按用户指定的序号定位商品。用同一价格口径核对差价，保留各款属性和缺失项。 |

目录的快照价没有采集日期。历史价格序列、实时库存和实时售价需要另有来源。若目录缺项，回答会说明可确认的信息和未知项。[规划字段](../web/policy.js) · [目录检索与指代](../web/rag.js) · [输入与回答格式](ANSWER-FORMAT.md)

## 核选与回答

```mermaid
flowchart TD
  RECEIVE["/v1/answer · 原问题、请求 ID 与目录证据"] --> ACTION{"本轮动作"}
  ACTION -->|新搜索| VERIFY["按计划中的必要词与排除词核对目录证据"]
  VERIFY --> ELIGIBLE{"还有可核选的候选？"}
  ELIGIBLE -->|否| EMPTY["返回目录无可确认商品与空推荐清单"]
  ELIGIBLE -->|是| RENUMBER["为 Ling 临时连续编号，保留原始编号映射"]
  RENUMBER --> SELECT["Ling 按原问题逐件核选，写正文和原文引句"]
  ACTION -->|详情或对比| EVIDENCE["保留清单序号，为对比提供以美分核算的价格证据"]
  EVIDENCE --> DESCRIBE["Ling 直接生成商品详情或比较正文"]
  SELECT --> CITE["逐款校验引句，必要时从同款目录字段提取原文"]
  CITE --> VALIDATE{"回答与适用的核选字段有效？"}
  DESCRIBE --> VALIDATE
  VALIDATE -->|无效且还有时间| REGEN["补充格式提示后重试一次"]
  REGEN -->|通过| RETURN["返回 paragraphs 与 selections，映射回原始候选编号"]
  VALIDATE -->|通过| RETURN
  REGEN -->|仍不通过| ERROR["记录校验失败，页面提示重试"]
  VALIDATE -->|无重试时间| ERROR
  RETURN --> SHOW["可折叠核对依据 → 正文与逐款理由 → 图片 → 目录来源"]
  EMPTY --> SHOWEMPTY["展示目录缺口说明"]
  SHOW --> HISTORY["按展示清单续问，日志保留召回顺序和实际引用"]
  SHOWEMPTY --> HISTORY
```

连接、模型生成或输出校验失败会在问答台显示错误与重试入口。失败的查询仍会写入对话日志。[推理接口](../training/serve.py) · [网页呈现与对话导出](../web/app.js) · [日志口径](../LOGS.md)

## 训练、评测与推理

```mermaid
flowchart TD
  RAW["WebShop 原始商品字段"] --> NORMAL["整理标题、选项、价格、规格与图片"]
  NORMAL --> CATALOG["779 件标准化商品目录"]
  CATALOG --> GROUP["按 ASIN 家族与近重复分组，隔离商品和问句模板"]
  GROUP --> TRAINSET["训练 623 件 · 1246 题"]
  GROUP --> VALIDATION["验证 78 件 · 156 题"]
  GROUP --> TESTSET["正式测试 78 件 · 156 题"]
  TRAINSET --> QLORA["Kaggle 单卡 · Ling-3.0-tiny 4-bit NF4 QLoRA"]
  VALIDATION -->|训练中检查损失| QLORA
  BASE["固定版本 Ling-3.0-tiny"] --> QLORA
  QLORA --> ADAPTER["正式 LoRA · 权重、参数配置、模型版本"]
  BASE -->|关闭适配器| EVAL["同测试题、提示和生成设置，对照底座与 LoRA"]
  ADAPTER -->|启用适配器| EVAL
  TESTSET -->|每模型 156 次，共 312 次| EVAL
  EVAL --> METRICS["有效 JSON、任务宏 F1、约束与完整计划匹配"]
  EVAL --> PERITEM["逐题计划预测与参考答案"]
  ADAPTER --> DEPLOY["Kaggle 推理 Notebook 加载正式适配器"]
  CATALOG --> WEB["Windows 问答台索引目录"]
  DEPLOY --> WEB
```

训练以问题和对话上下文为输入，以标准任务计划为目标。基座与 LoRA 共用同一套留出测试题。[训练与评测指南](../RECIPE.md)记录数据和复现命令。
