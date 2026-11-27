"use strict";
const $ = id => document.getElementById(id);
const {products, meta} = ShopCatalog;
const idx = ShopRag.index(products);
const storageKey = "webshop-rag-779-v1";
const defaultFeedback = $("feedback").textContent;
const categories = Object.keys(meta.byCategory);
const coverIds = {beauty:"B07B6DVG41", garden:"B06Y3VLDFB"};
const catalogGroups = new Map(categories.map(key => [key, products.filter(p => p.category === key)]));
const examples = [
  ["找 50 美元以内的女士鞋", "我想买一双 8.5 码的女士鞋，预算 50 美元以内。给我图片、历史价格和推荐理由，并列出颜色与尺码信息。"],
  ["挑选美妆个护", "从美妆个护里挑几件 25 美元以内的商品，给我图片，并说明怎么选。"],
  ["核对配件兼容性", "找 30 美元以内适配 iPhone 13 的手机壳，给我图片并说明兼容性。"]
];

function newId() {
  return globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}
function emptyThread() {
  return {id:newId(), state:{}, events:[]};
}

let thread = emptyThread();
let threads = new Map();
const deletedThreads = new Set();
let view = {kind:"home"};
let settings = null;
let processing = null;
let connecting = false;
let pending = null;
let storageFailed = false;
let historyRevision = 0;
let archiveQueue = Promise.resolve();
let archiveState = "saving";

try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
  if (saved?.schema === 2 && Array.isArray(saved.threads)) {
    threads = new Map(saved.threads.map(item => [item.id, item]));
    for (const id of Array.isArray(saved.deleted) ? saved.deleted : []) { deletedThreads.add(id); threads.delete(id); }
    thread = threads.get(saved.active) ?? thread;
  } else if (Array.isArray(saved?.logs)) {
    for (const event of saved.logs) {
      if (!event.session) continue;
      if (!threads.has(event.session)) threads.set(event.session, {id:event.session,state:{},events:[]});
      const previous = threads.get(event.session);
      previous.events.push(event);
      if (event.answer?.state) previous.state = event.answer.state;
    }
    if (saved.thread && Array.isArray(saved.thread.events)) {
      thread = saved.thread;
      if (thread.events.length) threads.set(thread.id,thread);
    }
  }
} catch { storageFailed = true; }
if (thread.events.length) view = {kind:"chat"};

function node(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content != null) el.textContent = content;
  return el;
}
function button(text, handler, className = "button") {
  const el = node("button",className,text);
  el.type = "button";
  el.addEventListener("click",handler);
  return el;
}
function feedback(message = defaultFeedback) {
  $("feedback").textContent = !frontNonce && storageFailed && message === defaultFeedback ?
    "浏览器存储不可用或已满。关闭前可从对话记录导出 TXT。" : message;
}
function historySnapshot(active = thread.id) {
  return {schema:2,active,threads:[...threads.values()].filter(item=>item.events.length),deleted:[...deletedThreads]};
}
function saveBrowser(snapshot) {
  try {
    localStorage.setItem(storageKey,JSON.stringify(snapshot));
    storageFailed = false;
  } catch { storageFailed = true; }
  feedback();
}
function renderArchiveStatus() {
  const status = $("archive-status");
  status.title = frontNonce ? "logs/conversations.json" : "通过启动问答.cmd 打开时可保存到项目";
  status.textContent = !frontNonce ? (storageFailed ? "浏览器保存失败，可导出 TXT。" : "对话保存在当前浏览器。") :
    archiveState === "saving" ? "正在同步项目记录…" : archiveState === "saved" ? "对话自动保存到项目。" :
    storageFailed ? "保存失败，可从对话记录导出 TXT。" : "项目存档失败，浏览器里仍有副本。";
}
function syncProject(snapshot, onRestore) {
  renderArchiveStatus();
  if (!frontNonce) return;
  const request = JSON.stringify({history:snapshot,restore:Boolean(onRestore)});
  archiveQueue = archiveQueue.then(async () => {
    archiveState = "saving";
    renderArchiveStatus();
    try {
      const response = await fetch("/bridge/history",{
        method:"POST",headers:{"Content-Type":"application/json","X-WebShop-Front":frontNonce},
        body:request,signal:AbortSignal.timeout(20000),cache:"no-store",redirect:"error"
      });
      if (!response.ok) throw Error("History archive unavailable");
      const result = await response.json();
      if (onRestore) onRestore(result);
      archiveState = "saved";
    } catch {
      archiveState = "failed";
    }
    renderArchiveStatus();
  });
}
function save() {
  historyRevision += 1;
  const snapshot = historySnapshot();
  saveBrowser(snapshot);
  syncProject(snapshot);
  renderSidebar();
}
function restoreProject() {
  const revision = historyRevision, initialView = view;
  syncProject(historySnapshot(thread.events.length ? thread.id : null),result => {
    if (result.schema !== 2 || !Array.isArray(result.threads) || !Array.isArray(result.deleted)) throw Error("Invalid history archive");
    for (const id of result.deleted) { deletedThreads.add(id); threads.delete(id); }
    const canRestore = revision === historyRevision && view === initialView;
    for (const item of result.threads) {
      if (!deletedThreads.has(item.id) && (canRestore || !threads.has(item.id))) threads.set(item.id,item);
    }
    if (canRestore) {
      thread = threads.get(result.active) ?? (deletedThreads.has(thread.id) ? emptyThread() : thread);
      view = {kind:thread.events.length ? "chat" : "home"};
      render();
      if (view.kind === "chat") scrollBottom();
    }
    saveBrowser(historySnapshot());
    renderSidebar();
  });
}
function updateComposer() {
  const input = $("question");
  input.rows = Math.min(5, Math.max(2,input.value.split("\n").length));
  $("send").disabled = Boolean(processing) || !input.value.trim();
}
function updateStatus() {
  $("status").classList.toggle("connected", Boolean(settings));
  $("status-text").textContent = settings ? "Kaggle LoRA 已连接" : "Kaggle 待连接";
  $("settings").firstChild.nodeValue = settings ? "Kaggle 连接 " : "连接 Kaggle ";
  $("disconnect").hidden = !settings;
}
function scrollBottom() {
  $("scroll").scrollTop = $("scroll").scrollHeight;
}

function image(src, alt, lazy = true) {
  const img = node("img");
  img.alt = alt;
  img.loading = lazy ? "lazy" : "eager";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.src = src;
  return img;
}
function media(src, alt, lazy = true) {
  const box = node("span","tile-media");
  if (src) {
    const img = image(src,alt,lazy);
    img.addEventListener("error",() => box.replaceChildren(node("span","placeholder","图片暂不可用")));
    box.append(img);
  } else box.append(node("span","placeholder","无图片记录"));
  return box;
}
function gallery(p, lazy = true) {
  const box = node("div","gallery");
  let position = 0;
  const counter = node("span");
  const backward = button("‹",() => move(-1),"icon-button");
  const forward = button("›",() => move(1),"icon-button");
  const controls = node("div","gallery-controls");
  backward.setAttribute("aria-label","前一张图片");
  forward.setAttribute("aria-label","后一张图片");
  counter.setAttribute("aria-live","polite");
  controls.append(backward,counter,forward);
  function draw() {
    box.replaceChildren(media(p.images[position],p.name,lazy));
    if (p.images.length > 1) {
      counter.textContent = (position + 1) + " / " + p.images.length;
      box.append(controls);
    }
  }
  function move(step) {
    position = (position + step + p.images.length) % p.images.length;
    draw();
    (step < 0 ? backward : forward).focus({preventScroll:true});
  }
  draw();
  return box;
}
function tile(label, subtext, src, handler, category = false) {
  const el = button("",handler,"tile" + (category ? " category-tile" : ""));
  const copy = node("span","tile-copy");
  copy.append(node("b",null,label),node("small",null,subtext));
  el.append(media(src,"",!category),copy);
  return el;
}
function coverProduct(key) {
  const group = catalogGroups.get(key);
  return idx.byId.get(coverIds[key]) ??
    group.find(p => p.images.length && (
      (key === "fashion" && p.shoe) ||
      (key === "electronics" && /\bheadphones?\b/i.test(p.name)) ||
      (key === "grocery" && /\b(?:tea|coffee|snack)\b/i.test(p.name))
    )) ?? group.find(p => p.images.length);
}
function catalogHeading(title, copy, count) {
  const head = node("div","cover");
  const intro = node("div");
  intro.append(node("h1",null,title));
  if (copy) intro.append(node("p",null,copy));
  head.append(intro,node("span","count",count + " 件商品"));
  return head;
}
function renderHome(catalog) {
  const grid = node("div","tiles");
  for (const key of categories) {
    const p = coverProduct(key);
    grid.append(tile(ShopRag.labels[key],meta.byCategory[key] + " 件",p?.images[0],() => {
      setView({kind:"category",category:key});
    },true));
  }
  const suggestions = node("section","suggestions");
  const prompts = node("div","prompts");
  for (const [label,question] of examples) {
    prompts.append(button(label,() => {
      if (processing) return;
      $("question").value = question;
      ask(question);
    }));
  }
  suggestions.append(node("h2",null,"试着问"),prompts);
  catalog.append(catalogHeading("浏览商品档案","选择类别，查看商品图片与详细资料。",meta.count),grid,suggestions);
}
function renderCategory(catalog, category) {
  const group = catalogGroups.get(category);
  const grid = node("div","tiles product-tiles");
  for (const p of group) {
    grid.append(tile(p.name,p.price == null ? "快照价未记录" : ShopRag.money(p.price),p.images[0],() => {
      setView({kind:"detail",id:p.id,back:{kind:"category",category,scroll:$("scroll").scrollTop}});
    }));
  }
  catalog.append(catalogHeading(ShopRag.labels[category],null,group.length),grid);
}

const unknown = "未记录";
function addPairs(container, pairs, className = "details") {
  const list = node("dl",className);
  for (const [label,value,field] of pairs) {
    const dd = node("dd");
    if (typeof value === "string") dd.textContent = value;
    else dd.append(value);
    if (field) dd.append(node("small",null,"字段 · " + field));
    list.append(node("dt",null,label),dd);
  }
  container.append(list);
}
function section(parent, title) {
  const el = node("section","detail-section");
  el.append(node("h2",null,title));
  parent.append(el);
  return el;
}
function addDetailList(parent, title, values) {
  const el = section(parent,title);
  if (!values.length) {
    el.append(node("p",null,unknown));
    return;
  }
  const list = node("ul");
  for (const value of values) list.append(node("li",null,value));
  el.append(list);
}
function optionRows(options) {
  const group = node("div");
  for (const option of options) {
    const row = node("div","variant-row");
    if (option.image) {
      const img = image(option.image,"");
      img.addEventListener("error",() => img.remove());
      row.append(img);
    }
    const price = option.price == null ? "价格未记录" : ShopRag.money(option.price);
    const flags = [price, option.selected && "快照所选", option.asin && "ASIN " + option.asin].filter(Boolean);
    row.append(node("span",null,option.value + "（" + flags.join(" · ") + "）"));
    group.append(row);
  }
  return group;
}
function renderDetail(catalog, p) {
  const pane = node("article","detail");
  const content = node("div","detail-content");
  const head = node("header","detail-header");
  const price = node("p","price",p.price == null ? unknown + " " : ShopRag.money(p.price) + " ");
  price.append(node("span",null,"目录快照价"));
  head.append(node("h1",null,p.name),node("p","trail",p.trail || ShopRag.labels[p.category]),price);
  content.append(head);
  const audience = {women:"女士",men:"男士",kids:"儿童",unisex:"通用"};
  const inventory = {in_stock:"曾记录为有货",out_of_stock:"曾记录为缺货"};
  addPairs(section(content,"商品属性"),[
    ["商品编号（ASIN）",p.id],["品牌",p.brand || unknown],["商品类",ShopRag.labels[p.category]],
    ["目录搜索词",p.query || unknown],["适用人群",audience[p.audience] || p.audience || unknown],["鞋履分类",p.shoe ? "是" : "否"],
    ["快照标示原价",p.listPrice == null ? unknown : ShopRag.money(p.listPrice)],
    ["库存快照",inventory[p.inventory] || p.inventory || unknown],["库存快照数量",p.quantity == null ? unknown : String(p.quantity)]
  ]);
  const pairs = Object.entries(p.specs).map(([k,v]) => [k,typeof v === "string" ? v : JSON.stringify(v)]);
  const specs = section(content,"规格");
  if (pairs.length) addPairs(specs,pairs);
  else specs.append(node("p",null,unknown));
  addDetailList(content,"材质",p.material.map(item => item.join(" · ")));
  const variants = section(content,"颜色、尺码与其他选项");
  const groups = Object.entries(p.variants).filter(([,items]) => items.length);
  if (groups.length) addPairs(variants,groups.map(([name,options]) => [name,optionRows(options)]));
  else variants.append(node("p",null,unknown));
  addDetailList(content,"尺码表",Object.entries(p.sizeChart).filter(([,sizes]) => sizes.length)
    .map(([system,sizes]) => system + " " + sizes.join("、")));
  addDetailList(content,"兼容性线索",p.compatibility);
  section(content,"商品描述").append(node("p",null,p.description || unknown));
  addDetailList(content,"商品要点",p.bullets);
  pane.append(gallery(p,false),content);
  catalog.append(pane);
}

function openAnswerProduct(card) {
  setView({kind:"detail",id:card.id,back:{kind:"chat",scroll:$("scroll").scrollTop}});
}
function productCard(card) {
  const label = "第 " + card.position + " 款 · " + card.name;
  const price = card.price == null ? "目录未标价" : "快照价 " + ShopRag.money(card.price);
  const el = tile(label,price,card.images?.[0],() => openAnswerProduct(card));
  el.classList.add("reply-product");
  el.title = label;
  return el;
}
function productEvidence(card) {
  const body = node("article","product-evidence");
  body.append(button("第 " + card.position + " 款 · " + card.name,() => openAnswerProduct(card),"evidence-product-button"),
    node("p","trail",[card.id,card.trail].filter(Boolean).join(" · ")));
  if (card.listPrice != null && card.listPrice !== card.price) {
    body.append(node("p","trail","快照标示原价 " + ShopRag.money(card.listPrice)));
  }
  if (card.facts?.length) addPairs(body,card.facts,"fact-list");
  if (card.reason) body.append(node("p","reason",card.reason));
  if (card.gaps?.length) body.append(node("p","gaps",card.gaps.join(" ")));
  return body;
}
function renderTurn(event) {
  const turn = node("article","turn");
  turn.dataset.questionId = event.questionId;
  const user = node("div","user-side");
  user.append(node("span","user-label","你"),node("p","user-msg",event.question));
  turn.append(user);
  const response = node("section","response");
  response.setAttribute("aria-label","模型回答");
  const mark = node("span","assistant-mark","W");
  mark.setAttribute("aria-hidden","true");
  const content = node("div","assistant-content");
  const model = event.mode === "remote" ? (event.adapter ? "Ling · LoRA 微调" : "Ling · 基座") :
    event.answer ? "历史记录" : "Kaggle GPU";
  content.append(node("p","reply-label",model));
  const bubble = node("div","reply-bubble");
  content.append(bubble);
  const out = event.answer;
  if (!out) {
    const running = event.pending && processing === event.questionId;
    bubble.append(node("p",null,running ? (event.progress ?? "正在 Kaggle GPU 上解析需求…") :
      event.error || "这条问题已保存，尚未收到回答。"));
    if (!running) content.append(button("重试此问题",() => {
      if (processing) return;
      $("question").value = event.question;
      ask(event.question);
    }));
  } else {
    for (const paragraph of out.reply_paragraphs ?? []) bubble.append(node("p",null,paragraph));
    if (!out.reply_paragraphs?.length) bubble.append(node("p",null,"此历史记录只保存了目录依据。"));
    if (out.conditions?.length || out.taskLabels?.length) {
      const chips = node("div","chips");
      for (const item of out.conditions ?? []) chips.append(node("span","chip condition",item));
      for (const item of out.taskLabels ?? []) chips.append(node("span","chip",item));
      content.append(chips);
    }
    const cards = out.cards ?? [];
    const withPictures = cards.filter(card=>card.images?.length || out.plan?.action === "search");
    if (withPictures.length) {
      const list = node("div","answer-grid");
      for (const card of withPictures) list.append(productCard(card));
      content.append(list);
    }
    if (cards.length) {
      const evidence = node("div","reply-meta");
      const details = node("details","answer-evidence");
      details.append(node("summary",null,"查看目录依据 · " + cards.length + " 款"));
      for (const card of cards) details.append(productEvidence(card));
      evidence.append(details);
      content.append(evidence);
    }
  }
  response.append(mark,content);
  turn.append(response);
  return turn;
}
function renderBreadcrumbs() {
  const nav = $("breadcrumbs");
  nav.replaceChildren();
  const source = view.kind === "detail" ? view.back : view;
  const label = source.kind === "chat" ? "商品问答" : "商品分类";
  const separator = () => {
    const el = node("span",null,"/");
    el.setAttribute("aria-hidden","true");
    return el;
  };
  if (view.kind === "home") nav.append(node("span",null,label));
  else nav.append(button(label,() => setView(source.kind === "chat" ? {kind:"chat"} : {kind:"home"}),"crumb-button"));
  if (source.kind === "category") {
    const title = ShopRag.labels[source.category];
    nav.append(separator(),view.kind === "detail" ? button(title,() => setView(source),"crumb-button") : node("span",null,title));
  }
  if (view.kind === "detail") nav.append(separator(),node("span",null,"商品详情"));
}
function render() {
  const catalog = $("catalog"), messages = $("messages");
  const chat = view.kind === "chat";
  catalog.hidden = chat;
  messages.hidden = !chat;
  catalog.replaceChildren();
  messages.replaceChildren();
  renderBreadcrumbs();
  if (chat) {
    for (const event of thread.events) messages.append(renderTurn(event));
    if (!thread.events.length) {
      const ready = settings ? "发送一条消息开始对话。" : "连接 Kaggle GPU 后即可发送问题。";
      messages.append(node("p","reply-summary",ready));
    }
  } else if (view.kind === "category") renderCategory(catalog,view.category);
  else if (view.kind === "detail") renderDetail(catalog,idx.byId.get(view.id));
  else renderHome(catalog);
}
function setView(next) {
  view = next;
  render();
  $("scroll").scrollTop = next.scroll ?? 0;
}

const replyMime = "application/vnd.webshop.reply+json";
const frontNonce = document.querySelector('meta[name="webshop-front"]')?.content;
async function relayRequest(path, data, timeout) {
  const response = await fetch("/bridge/" + path,{
    method:"POST",headers:{"Content-Type":"application/json","X-WebShop-Front":frontNonce},
    body:JSON.stringify(data),signal:AbortSignal.timeout(timeout),cache:"no-store",redirect:"error"
  });
  if (!response.ok) throw new ConnectionError("问答台无法连接 Kaggle Jupyter Server。请核对会话仍在运行，并重新复制地址。");
  return response.json();
}
class ConnectionError extends Error {}
function kaggleEndpoint(raw) {
  let url;
  try { url = new URL(raw.trim()); }
  catch { throw new ConnectionError("请从 Kaggle 复制完整的 VSCode Compatible URL。"); }
  const path = url.pathname.replace(/\/(?:tree|lab)(?:\/.*)?$|\/+$/g,"");
  const allowed = /^[a-z0-9-]+\.jupyter-proxy\.kaggle\.net$/i.test(url.hostname) &&
    /^\/k\/\d+\/[A-Za-z0-9._~%=-]+\/proxy$/.test(path);
  if (!allowed || url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new ConnectionError("请粘贴 Kaggle Jupyter Server 提供的 VSCode Compatible URL。");
  }
  return {base:url.origin + path, token:url.searchParams.get("token")};
}
function sessionURL(config, path) {
  const url = new URL(config.base + path);
  if (config.token) url.searchParams.set("token",config.token);
  return url;
}
async function listKernels(config) {
  let kernels;
  if (frontNonce) {
    kernels = await relayRequest("kernels",{base:config.base,token:config.token},14000);
  } else {
    const result = await fetch(sessionURL(config,"/api/kernels"),{
      signal:AbortSignal.timeout(12000),credentials:"omit",redirect:"error",cache:"no-store",referrerPolicy:"no-referrer"
    });
    if (!result.ok) throw new ConnectionError("Kaggle 会话未验证成功。请保持会话运行并重新复制地址。");
    kernels = await result.json();
  }
  if (!Array.isArray(kernels)) throw new ConnectionError("Kaggle 会话未返回可用的 Jupyter 内核列表。");
  return kernels.filter(k => /^[a-zA-Z0-9_-]+$/.test(k.id ?? "") && /python/i.test(k.name ?? ""))
    .sort((a,b) => String(b.last_activity).localeCompare(String(a.last_activity)));
}

function plannerCode(path, payload) {
  const encoded = btoa(Array.from(new TextEncoder().encode(JSON.stringify(payload ?? null)), byte => String.fromCharCode(byte)).join(""));
  return [
    "def _webshop_browser_bridge():",
    "    import base64, json, os, urllib.request, urllib.error",
    "    from IPython.display import display",
    "    payload = base64.b64decode('" + encoded + "')",
    "    service = globals().get('service_env', {})",
    "    key = service.get('WEBSHOP_SERVICE_TOKEN') if isinstance(service, dict) else None",
    "    key = key or os.getenv('WEBSHOP_SERVICE_TOKEN')",
    "    existing_request = globals().get('planner_request')",
    "    if not key and callable(existing_request):",
    "        try:",
    "            data = existing_request('" + path + "', json.loads(payload))",
    "        except Exception:",
    "            data = {'bridge_error': 'service-not-ready'}",
    "        display({'" + replyMime + "': data}, raw=True)",
    "        return",
    "    if not key:",
    "        try:",
    "            from kaggle_secrets import UserSecretsClient",
    "            key = UserSecretsClient().get_secret('WEBSHOP_SERVICE_TOKEN')",
    "        except Exception:",
    "            pass",
    "    if not isinstance(key, str) or not key:",
    "        data = {'bridge_error': 'service-not-ready'}",
    "    else:",
    "        request = urllib.request.Request('http://127.0.0.1:8008" + path + "',",
    "            data=None if payload == b'null' else payload,",
    "            headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})",
    "        try:",
    "            with urllib.request.urlopen(request, timeout=" + (payload ? "120" : "8") + ") as response:",
    "                data = json.load(response)",
    "        except urllib.error.HTTPError as error:",
    "            data = {'bridge_error': 'planner-http', 'status': error.code}",
    "            if error.code == 422:",
    "                try:",
    "                    detail = json.loads(error.read(8192)).get('detail')",
    "                    if detail == 'Invalid planner output':",
    "                        data['stage'] = 'model_output'",
    "                    elif detail == 'Invalid model answer':",
    "                        data['stage'] = 'model_answer'",
    "                    elif detail == 'Planner input or generation value is invalid' or isinstance(detail, list):",
    "                        data['stage'] = 'request_or_generation'",
    "                except (ValueError, TypeError, AttributeError, OSError):",
    "                    pass",
    "        except (OSError, ValueError):",
    "            data = {'bridge_error': 'service-not-ready'}",
    "    display({'" + replyMime + "': data}, raw=True)",
    "_webshop_browser_bridge()",
    "del _webshop_browser_bridge"
  ].join("\n");
}
function requirePlannerReply(result) {
  if (result && !result.bridge_error) return result;
  const status = result?.bridge_error === "planner-http" ? result.status : null;
  const stage = ["model_output","model_answer","request_or_generation"].includes(result?.stage) ? result.stage : null;
  const error = new ConnectionError(status === 422 ?
    (stage === "model_answer" ? "Kaggle 模型本轮未能生成回答，可以点「重试此问题」。" :
      stage === "model_output" ? "Kaggle 模型本轮未能返回可执行的计划，可以点「重试此问题」。" :
      "Kaggle 未能完成这次请求，可以点「重试此问题」。") :
    status === 429 ? "Kaggle 模型正忙，请稍后重试此问题。" :
      "Kaggle 内核中的 WebShop 推理服务未就绪或请求失败。请确认已在一键推理 Notebook 中执行 Run All，并看到模型就绪提示。");
  error.plannerStatus = status;
  error.plannerStage = stage;
  throw error;
}
async function callPlanner(config, kernelId, path, payload) {
  const session = newId();
  const requestId = newId();
  const header = {msg_id:requestId,username:"webshop",session,date:new Date().toISOString(),msg_type:"execute_request",version:"5.3"};
  const content = {code:plannerCode(path,payload),silent:false,store_history:false,user_expressions:{},allow_stdin:false,stop_on_error:false};
  const request = {header,parent_header:{},metadata:{},content,channel:"shell",buffers:[]};
  if (frontNonce) {
    const result = await relayRequest("execute",{base:config.base,token:config.token,kernelId,request,health:!payload},
      payload ? 130000 : 22000);
    return requirePlannerReply(result);
  }
  const url = sessionURL(config,"/api/kernels/" + kernelId + "/channels");
  url.protocol = "wss:";
  url.searchParams.set("session_id",session);
  return new Promise((resolve,reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => finish(null,new ConnectionError(
      payload ? "Kaggle 推理超时，请稍后重试。" : "Jupyter 内核没有及时响应，请确认推理单元已经就绪。"
    )),payload ? 130000 : 20000);
    let result;
    let done = false;
    function finish(value, error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve(value);
    }
    ws.addEventListener("open",() => ws.send(JSON.stringify(request)));
    ws.addEventListener("message",event => {
      if (typeof event.data !== "string") return;
      let packet;
      try { packet = JSON.parse(event.data); }
      catch { return; }
      if (packet.parent_header?.msg_id !== requestId) return;
      const type = packet.header?.msg_type;
      if (type === "display_data") result = packet.content?.data?.[replyMime] ?? result;
      if (type === "status" && packet.content?.execution_state === "idle") {
        try { finish(requirePlannerReply(result)); }
        catch (error) { finish(null,error); }
      }
    });
    const failed = () => finish(null,new ConnectionError("浏览器未能连接 Kaggle Jupyter 通道，请确认会话仍在运行并重新复制地址。"));
    ws.addEventListener("error",failed);
    ws.addEventListener("close",failed);
  });
}
async function getConnection(raw) {
  const config = kaggleEndpoint(raw);
  let kernels;
  try { kernels = await listKernels(config); }
  catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError(frontNonce ? "连接 Kaggle 会话超时。请确认会话仍在运行，并重新复制地址。" :
      "浏览器无法直接读取 Kaggle 会话。请通过项目中的「启动问答.cmd」打开问答台，再连接 Kaggle。");
  }
  if (!kernels.length) throw new ConnectionError("Kaggle 会话还没有运行中的 Python 内核，请先运行推理单元。");
  let failure;
  for (const kernel of kernels.slice(0,3)) {
    try {
      const health = await callPlanner(config,kernel.id,"/health");
      if (health.service !== "webshop-ling-planner" || health.ready !== true || health.adapter !== true || health.smoke_adapter === true) {
        throw new ConnectionError("当前会话未加载正式的 WebShop LoRA 推理服务。");
      }
      if (!(health.model_and_config_version?.planner_protocol >= 4)) {
        throw new ConnectionError("当前 Kaggle 会话不支持证据核选。请导入项目内的 kaggle/webshop-ling-inference.ipynb，运行后重新连接。");
      }
      return {...config,kernelId:kernel.id,version:health.model_and_config_version ?? {
        model:"Ling-3.0-tiny",revision:health.revision ?? null,config_version:null
      }};
    } catch (error) { failure = error; }
  }
  throw failure;
}

function showSettings() {
  $("connect-result").textContent = "";
  if (!$("connection").open) $("connection").showModal();
}
function answerEvidence(out) {
  const short = (text, limit) => String(text ?? "").replace(/\s+/g," ").trim().slice(0,limit);
  const catalog = {
    action:out.plan.action, tasks:out.taskLabels, filters:out.conditions, recalled_count:out.matched,
    result_limit:out.plan.limit,
    notes:out.notes.map(text=>short(text,300)),
    products:out.cards.map(card=>{
      const product = idx.byId.get(card.id);
      const facts = card.facts.map(([label,value])=>[label,short(value,label === "规格" ? 200 : 150)]);
      if (product?.material.length && !facts.some(([label])=>label === "材质")) {
        facts.push(["材质",short(product.material.map(([label,value])=>label+" · "+value).join("；"),150)]);
      }
      return {
        position:card.position, asin:card.id, name:short(card.name,160), category_path:short(card.trail,165),
        description:short(product?.description,500), highlights:(product?.bullets ?? []).slice(0,2).map(text=>short(text,150)),
        snapshot_price_usd:card.price === null ? null : card.price / 100,
        image_available:Boolean(card.images.length),
        facts,
        matched_evidence:[...new Set((card.matchedEvidence ?? []).map(item=>item.excerpt))].map(text=>short(text,210)),
        gaps:card.gaps.map(text=>short(text,140))
      };
    })
  };
  const encoded = JSON.stringify(catalog);
  if (encoded.length <= 12000 && new TextEncoder().encode(encoded).length <= 22000) return encoded;
  for (const product of catalog.products) {
    product.facts = product.facts.map(([label,value])=>[label,short(value,65)]);
    product.description = short(product.description,260);
    product.highlights = product.highlights.map(text=>short(text,65));
    product.matched_evidence = product.matched_evidence.map(text=>short(text,80));
    product.gaps = product.gaps.map(text=>short(text,75));
  }
  return JSON.stringify(catalog);
}
function selectedSearchAnswer(retrieved, selections, state, question) {
  if (!Array.isArray(selections) || selections.length > retrieved.plan.limit) {
    throw new ConnectionError("Kaggle 未返回可核对的商品清单，请重试。");
  }
  const candidates = new Map(retrieved.cards.map(card=>[card.position,card]));
  const cards = selections.map(({position,quote},i)=>{
    const card = candidates.get(position);
    if (!card || typeof quote !== "string" || !quote.trim()) {
      throw new ConnectionError("Kaggle 未返回可核对的商品清单，请重试。");
    }
    candidates.delete(position);
    return {...card,position:i+1,facts:[...card.facts,["推荐依据原文",quote,"目录证据"]]};
  });
  return {...retrieved,cards,state:cards.length ? {resultIds:cards.map(card=>card.id),active:cards.length === 1 ? 1 : null,
    lastQuestion:question} : state};
}
async function ask(text) {
  const question = text.trim();
  if (!question || processing || question.length > 1500) return;
  if (view.kind !== "chat") setView({kind:"chat"});
  if (!settings) {
    pending = {id:thread.id,question};
    showSettings();
    return;
  }
  const owner = thread;
  const config = settings;
  const event = {type:"question",time:new Date().toISOString(),session:owner.id,question,mode:"remote",
    questionId:newId(),adapter:true,version:config.version,pending:true};
  processing = event.questionId;
  pending = null;
  owner.events.push(event);
  threads.set(owner.id,owner);
  save();
  $("question").value = "";
  updateComposer();
  render();
  scrollBottom();
  const start = performance.now();
  let stage = "plan";
  let retrieved;
  try {
    const prior = (owner.state.resultIds || []).map((id,i) => ({position:i+1,id,name:idx.byId.get(id)?.name.slice(0,140)}));
    const result = await callPlanner(config,config.kernelId,"/v1/plan",{question,questionId:event.questionId,
      context:{lastQuestion:owner.state.lastQuestion,active:owner.state.active,previousResults:prior}});
    if (!result.plan || result.adapter !== true || result.smoke_adapter === true) {
      throw new ConnectionError("Kaggle 会话未返回有效的 WebShop LoRA 计划，请重新连接后重试。");
    }
    event.version = result.model_and_config_version ?? config.version;
    event.planningMs = result.generation_ms ?? null;
    event.generationMs = event.planningMs;
    event.modelOutput = result.plan;
    retrieved = ShopRag.runModel(idx,question,owner.state,result.plan);
    stage = "answer";
    event.progress = "已核对目录，正在 Kaggle GPU 上生成回答…";
    if (thread.id === owner.id && view.kind === "chat") render();
    const reply = await callPlanner(config,config.kernelId,"/v1/answer",{question,questionId:event.questionId,
      catalog:answerEvidence(retrieved)});
    if (!Array.isArray(reply.paragraphs) || !reply.paragraphs.length ||
        reply.paragraphs.some(paragraph=>typeof paragraph !== "string" || !paragraph.trim())) {
      throw new ConnectionError("Kaggle 模型本轮未能生成回答，可以点「重试此问题」。");
    }
    event.answerGenerationMs = reply.generation_ms ?? null;
    if (event.answerGenerationMs !== null) event.generationMs = (event.planningMs ?? 0) + event.answerGenerationMs;
    const displayed = retrieved.plan.action === "search" ? selectedSearchAnswer(retrieved,reply.selections,owner.state,question) : retrieved;
    event.answer = {...displayed,reply_paragraphs:reply.paragraphs};
    owner.state = displayed.state;
  } catch (error) {
    event.plannerStatus = error.plannerStatus ?? null;
    event.plannerStage = error.plannerStage ?? null;
    if (retrieved) {
      event.recalledPages = retrieved.recalledPages;
      event.retrievalMs = retrieved.retrievalMs;
    }
    event.issue = stage === "answer" ? "answer_failed" :
      event.modelOutput || event.plannerStage === "model_output" ? "invalid_model_plan" :
      event.plannerStatus === 422 ? "planner_rejected" : "planner_unavailable";
    event.resolution = "retry_kaggle";
    event.error = error instanceof ConnectionError ? error.message : "本轮未能使用模型计划查询商品，请重试。";
  } finally {
    event.pending = false;
    delete event.progress;
    event.elapsedMs = Math.round(performance.now() - start);
    processing = null;
    save();
    updateComposer();
    if (thread.id === owner.id && view.kind === "chat") {
      const current = Array.from($("messages").children).find(el => el.dataset.questionId === event.questionId);
      if (current) current.replaceWith(renderTurn(event));
      else render();
    }
  }
}

function historyDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未记录" : new Intl.DateTimeFormat("zh-CN",{dateStyle:"medium",timeStyle:"short"}).format(date);
}
function historyEntries() {
  return [...threads.values()].filter(item => item.events.length)
    .sort((a,b) => b.events.at(-1).time.localeCompare(a.events.at(-1).time));
}
function toggleTools(open = false) {
  if (!open) closeThreadActions();
  $("workspace-tools").classList.toggle("is-open",open);
  $("toggle-workspace-tools").setAttribute("aria-expanded",String(open));
}
function resumeThread(item) {
  const switching = thread.id !== item.id;
  thread = item;
  if (switching) $("question").value = "";
  pending = null;
  toggleTools();
  setView({kind:"chat"});
  save();
  updateComposer();
  scrollBottom();
  $("question").focus();
}
const threadActions = $("thread-actions");
let actionTarget = null;
let deleteTarget = null;

function closeThreadActions(restoreFocus = false) {
  if (!actionTarget) return;
  const {anchor, more} = actionTarget;
  actionTarget = null;
  threadActions.hidden = true;
  more.setAttribute("aria-expanded","false");
  if (restoreFocus && anchor.isConnected) anchor.focus();
}
function showThreadActions(event, item, anchor, more, point) {
  event.preventDefault();
  closeThreadActions();
  actionTarget = {id:item.id,anchor,more};
  more.setAttribute("aria-expanded","true");
  threadActions.hidden = false;
  const {width,height} = threadActions.getBoundingClientRect();
  const position = point ?? anchor.getBoundingClientRect();
  threadActions.style.left = Math.max(6,Math.min(position.x,window.innerWidth - width - 6)) + "px";
  threadActions.style.top = Math.max(6,Math.min(position.y + (point ? 0 : position.height),window.innerHeight - height - 6)) + "px";
  $("delete-thread").focus();
}
function threadRow(item) {
  const title = item.events[0].question;
  const row = node("div","recent-thread-row");
  const open = button("",() => resumeThread(item),"recent-thread");
  const more = button("⋯",event => {
    if (actionTarget?.more === more) closeThreadActions(true);
    else showThreadActions(event,item,more,more);
  },"thread-more");
  open.title = title;
  if (item.id === thread.id) open.setAttribute("aria-current","true");
  open.append(node("b",null,title),node("small",null,historyDate(item.events.at(-1).time) + " · " + item.events.length + " 轮"));
  more.setAttribute("aria-label","对话操作：" + title);
  more.setAttribute("aria-controls","thread-actions");
  more.setAttribute("aria-expanded","false");
  row.addEventListener("contextmenu",event => {
    const point = event.button === 2 ? {x:event.clientX,y:event.clientY} : null;
    showThreadActions(event,item,open,more,point);
  });
  row.addEventListener("keydown",event => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      showThreadActions(event,item,event.target,more);
    }
  });
  row.append(open,more);
  return row;
}
function renderSidebar() {
  const list = $("recent-thread-list");
  const entries = historyEntries();
  const openActionsFor = actionTarget?.id;
  closeThreadActions();
  list.replaceChildren();
  if (!entries.length) list.append(node("p",null,"还没有对话记录。"));
  for (const item of entries) {
    const row = threadRow(item);
    list.append(row);
    if (openActionsFor === item.id) row.firstChild.focus();
  }
}
function deleteThread(id) {
  if (!threads.delete(id)) return;
  deletedThreads.add(id);
  if (thread.id === id) {
    thread = emptyThread();
    pending = null;
    $("question").value = "";
    setView({kind:"home"});
    updateComposer();
  }
  save();
  $("history-action-status").textContent = "已从列表移除对话。";
  $("new-thread").focus();
}
function exportThread(threadToExport) {
  const content = threadToExport.events.map(item => JSON.stringify(ShopRag.questionRecord({
    id:item.questionId ?? item.session + "-" + item.time,question:item.question,answer:item.answer,
    modelOutput:item.modelOutput,generationMs:item.generationMs,version:item.version,time:item.time,session:item.session,
    mode:item.mode,attempted_model_version:item.attemptedVersion ?? null,issue:item.issue ?? (item.pending ? "pending" : null),
    planner_status:item.plannerStatus ?? null,planner_stage:item.plannerStage ?? null,
    planning_ms:item.planningMs ?? null,answer_generation_ms:item.answerGenerationMs ?? null,
    recalled_pages:item.answer?.recalledPages ?? item.recalledPages ?? null,
    retrieval_ms:item.answer?.retrievalMs ?? item.retrievalMs ?? null,
    resolution:item.resolution ?? null,error:item.error ?? item.code ?? null
  }))).join("\n");
  if (!content) return;
  const url = URL.createObjectURL(new Blob([content + "\n"],{type:"text/plain;charset=utf-8"}));
  const download = node("a");
  download.href = url;
  const exportId = threadToExport.id.replace(/[^a-z0-9-]/gi,"").slice(0,16);
  download.download = "webshop-conversation-" + exportId + ".txt";
  download.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
  $("history-action-status").textContent = "已导出这条对话的记录。";
}

const resizer = $("workspace-resizer");
const workspace = resizer.parentElement;
const toolsWidthKey = "webshop-tools-width";
const minToolsWidth = 148;
const largestToolsWidth = 360;
let preferredToolsWidth = 218;
let drag = null;

try {
  const savedWidth = Number(localStorage.getItem(toolsWidthKey));
  if (savedWidth >= minToolsWidth && savedWidth <= largestToolsWidth) preferredToolsWidth = savedWidth;
} catch {}

function maxToolsWidth() {
  return Math.max(minToolsWidth,Math.min(largestToolsWidth,Math.floor(window.innerWidth * .43)));
}
function toolsWidth(width) {
  return Math.min(maxToolsWidth(),Math.max(minToolsWidth,Math.round(width)));
}
function renderToolsWidth(width) {
  const visible = toolsWidth(width);
  workspace.style.setProperty("--tools-width",visible + "px");
  resizer.setAttribute("aria-valuemax",String(maxToolsWidth()));
  resizer.setAttribute("aria-valuenow",String(visible));
}
function saveToolsWidth(width) {
  preferredToolsWidth = toolsWidth(width);
  renderToolsWidth(preferredToolsWidth);
  try { localStorage.setItem(toolsWidthKey,String(preferredToolsWidth)); } catch {}
}
function finishToolsDrag(event) {
  if (drag?.id !== event.pointerId) return;
  if (event.type !== "pointercancel" && drag.width !== drag.startWidth) saveToolsWidth(drag.width);
  else renderToolsWidth(preferredToolsWidth);
  drag = null;
  document.body.classList.remove("resizing-tools");
}

$("composer").addEventListener("submit",event => {event.preventDefault(); ask($("question").value);});
$("question").addEventListener("input",updateComposer);
$("question").addEventListener("keydown",event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!$("send").disabled) $("composer").requestSubmit();
  }
});
$("home").addEventListener("click",() => setView({kind:"home"}));
$("toggle-workspace-tools").addEventListener("click",() => {
  toggleTools(!$("workspace-tools").classList.contains("is-open"));
});
$("new-thread").addEventListener("click",() => {
  thread = emptyThread();
  pending = null;
  $("question").value = "";
  toggleTools();
  setView({kind:"home"});
  save();
  updateComposer();
  $("question").focus();
});
$("delete-thread").addEventListener("click",() => {
  const target = actionTarget;
  const item = target && threads.get(target.id);
  closeThreadActions();
  if (!item) return;
  deleteTarget = target;
  $("delete-thread-name").textContent = item.events[0].question;
  const dialog = $("delete-thread-dialog");
  dialog.returnValue = "";
  dialog.showModal();
});
$("cancel-delete-thread").addEventListener("click",() => $("delete-thread-dialog").close());
$("confirm-delete-thread").addEventListener("click",() => $("delete-thread-dialog").close("delete"));
$("delete-thread-dialog").addEventListener("close",event => {
  const target = deleteTarget;
  deleteTarget = null;
  if (!target) return;
  if (event.currentTarget.returnValue === "delete") deleteThread(target.id);
  else if (target.anchor.isConnected) target.anchor.focus();
});
$("export-thread").addEventListener("click",() => {
  const item = actionTarget && threads.get(actionTarget.id);
  closeThreadActions(true);
  if (item) exportThread(item);
});
document.addEventListener("pointerdown",event => {
  if (actionTarget && !threadActions.contains(event.target) && !actionTarget.more.contains(event.target)) closeThreadActions();
});
document.addEventListener("focusin",event => {
  if (actionTarget && !threadActions.contains(event.target) && event.target !== actionTarget.more) closeThreadActions();
});
threadActions.addEventListener("keydown",event => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeThreadActions(true);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    (event.target === $("delete-thread") ? $("export-thread") : $("delete-thread")).focus();
  }
});
$("recent-thread-list").addEventListener("scroll",() => closeThreadActions(true),{passive:true});
window.addEventListener("resize",() => {
  closeThreadActions(true);
  renderToolsWidth(drag?.width ?? preferredToolsWidth);
});
resizer.addEventListener("pointerdown",event => {
  if (event.button !== 0 || drag) return;
  const startWidth = $("workspace-tools").getBoundingClientRect().width;
  resizer.setPointerCapture(event.pointerId);
  drag = {id:event.pointerId,x:event.clientX,width:startWidth,startWidth};
  document.body.classList.add("resizing-tools");
});
resizer.addEventListener("pointermove",event => {
  if (drag?.id !== event.pointerId) return;
  drag.width = toolsWidth(drag.startWidth + event.clientX - drag.x);
  renderToolsWidth(drag.width);
});
for (const type of ["pointerup","pointercancel","lostpointercapture"]) {
  resizer.addEventListener(type,finishToolsDrag);
}
resizer.addEventListener("keydown",event => {
  const width = toolsWidth(preferredToolsWidth);
  const changes = {ArrowLeft:width - 12,ArrowRight:width + 12,Home:minToolsWidth,End:maxToolsWidth()};
  if (!Object.hasOwn(changes,event.key)) return;
  event.preventDefault();
  saveToolsWidth(changes[event.key]);
});
renderToolsWidth(preferredToolsWidth);
$("settings").addEventListener("click",showSettings);
$("back-to-kaggle-address").addEventListener("click",() => {
  $("connection-guide").open = false;
  $("endpoint").focus();
});
$("close-settings").addEventListener("click",() => $("connection").close());
$("connection").addEventListener("close",() => {
  $("connection-guide").open = false;
  if (!connecting) $("endpoint").value = "";
  pending = null;
});
$("disconnect").addEventListener("click",() => {
  settings = null;
  updateStatus();
  $("connection").close();
  if (view.kind === "chat" && !thread.events.length) render();
});
$("connection-form").addEventListener("submit",async event => {
  event.preventDefault();
  if (connecting) return;
  connecting = true;
  $("connect").disabled = true;
  $("disconnect").disabled = true;
  $("connect-result").textContent = "正在核对 Kaggle GPU 上的 LoRA 推理服务…";
  try {
    const config = await getConnection($("endpoint").value);
    if (!$("connection").open) return;
    settings = config;
    const request = pending;
    pending = null;
    $("endpoint").value = "";
    updateStatus();
    $("connection").close();
    if (request?.id === thread.id && request.question === $("question").value.trim() && !processing) {
      ask(request.question);
    } else if (view.kind === "chat" && !thread.events.length) render();
  } catch (error) {
    $("connect-result").textContent = error instanceof ConnectionError ? error.message :
      "连接失败。请确认 Kaggle GPU 会话仍在运行，并重新复制 VSCode Compatible URL。";
  } finally {
    connecting = false;
    $("connect").disabled = false;
    $("disconnect").disabled = false;
    if (!$("connection").open) $("endpoint").value = "";
  }
});
render();
renderSidebar();
updateComposer();
updateStatus();
feedback();
if (view.kind === "chat") scrollBottom();
restoreProject();
