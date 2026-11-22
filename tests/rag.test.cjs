const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("../web/catalog");
const rag = require("../web/rag");
const {products,meta} = globalThis.ShopCatalog;
const idx = rag.index(products);
const ask = (q,state,plan)=>rag.run(idx,q,state,plan);
const browse = ()=>ask("目录里有哪些女士鞋款？给我看看图片、历史价格和已记录的尺码。");

test("catalog includes 779 unique ASINs and records snapshot provenance",()=>{
  assert.equal(idx.byId.size,779);
  assert.equal(meta.imageCount,778);
  assert.equal(meta.variantSizePriceCount,60);
  assert.equal(meta.snapshotDate,null);
});
test("8.5 shoes answer all requested tasks with four budget-qualified records",()=>{
  const result = ask("我想给女朋友买一双8.5码的女士鞋，预算50美元以内。请给我图片、历史价格和推荐理由，并列出颜色与尺码信息。");
  assert.equal(result.plan.max_price,50);
  assert.equal(result.plan.size_system,"US");
  assert.deepEqual(result.cards.map(c=>c.id),["B09S3TWKSC","B09RPRRNVP","B09QL82H1L","B09QKJHF4Q"]);
  for (const card of result.cards) {
    assert(card.price <= 5000 && card.images.length && card.reason);
    assert(card.facts.some(([key])=>key==="目标尺码"));
  }
  assert(result.notes.some(x=>x.includes("价格快照") && x.includes("趋势")));
});

test("a search reply puts price and size in plain language and labels price gaps",()=>{
  const result = ask("我想买一双 8.5 码的女士鞋，预算 50 美元以内。给我图片、历史价格和推荐理由，并列出颜色与尺码信息。");
  const paragraphs = rag.replyParagraphs(result);
  assert.match(paragraphs[0], /4 款符合筛选条件的女士鞋/);
  assert.match(paragraphs[0], /8\.5 码选项/);
  assert.match(paragraphs[0], /\$6\.99 到 \$37\.99/);
  assert(paragraphs.some(text=>text.includes("米色、黑色、金色")));
  assert(paragraphs.some(text=>text.includes("缺少按日期排列的历史价格")));
  assert(result.taskLabels.includes("核对尺码"));
});

test("a follow-up about these four products explains each recorded material and its gaps",()=>{
  const first = ask("找 50 美元以内的 8.5 码女士鞋，给我图片和尺码。");
  const result = ask("告诉我这四款鞋的面料分别是什么，用中文回答我。",first.state);
  const paragraphs = rag.replyParagraphs(result);
  assert.equal(result.plan.action,"detail");
  assert.deepEqual(result.cards.map(card=>card.id),first.cards.map(card=>card.id));
  assert(paragraphs.some(text=>text.includes("第 2 款") && text.includes("鞋面为网布") && text.includes("鞋底为橡胶")));
  assert(paragraphs.some(text=>text.includes("第 3 款") && text.includes("没有明确标注材质")));
});

test("a comparison starts with the verified price difference",()=>{
  const first = ask("找 50 美元以内的 8.5 码女士鞋，给我图片和尺码。");
  const result = ask("第一款和第三款哪个更便宜？差多少钱？",first.state);
  assert.match(rag.replyParagraphs(result)[0], /第 1 款的目录快照价更低.*相差 \$16\.30/);
});
test("women's shoe browse corrects the inaccurate breadcrumb",()=>{
  const result = browse();
  assert.equal(result.cards.length,6);
  assert(!result.cards.some(c=>c.id==="B094RBNS2K"));
  assert(result.cards.some(c=>c.price===8999));
});
test("beauty results respect category, budget, and include varied product types",()=>{
  const result = ask("从美妆个护里挑几件25美元以内的商品，给我图片，并说明怎么选。");
  assert.equal(result.cards.length,4);
  assert(result.cards.every(c=>c.category==="beauty" && c.price<=2500 && c.images.length && c.reason));
  assert(new Set(result.cards.map(c=>idx.byId.get(c.id).query)).size>=3);
});
test("details, comparison, per-size prices and recommendation preserve ordinals",()=>{
  const first = browse();
  const detail = ask("介绍第三款的颜色、材质和规格，资料缺失的地方也告诉我。",first.state);
  assert.equal(detail.cards[0].id,first.cards[2].id);
  assert.deepEqual(detail.state.resultIds,first.state.resultIds);
  assert(detail.cards[0].facts.length && detail.cards[0].gaps.length);
  const compare = ask("第一款和第三款哪个更便宜？差多少钱？它们的主要区别是什么？",detail.state);
  assert(compare.notes[0].includes(rag.money(Math.abs(first.cards[0].price-first.cards[2].price))));
  const variants = ask("刚才第二款记录了哪些尺码？这些尺码有各自的价格吗？",compare.state);
  assert.equal(variants.cards[0].id,first.cards[1].id);
  assert(variants.cards[0].gaps.some(x=>x.includes("独立标价未记录")));
  const reason = ask("我比较喜欢第一款。结合它的具体属性，说说选择它的理由和还需要确认的信息。",variants.state);
  assert.equal(reason.plan.action,"detail");
  assert.equal(reason.cards[0].id,first.cards[0].id);
  assert(reason.cards[0].reason);
  assert(ask("这款现在有货吗？",reason.state).cards[0].gaps.some(x=>x.includes("当前库存")));
});
test("size option and size chart are distinct evidence",()=>{
  const product = idx.byId.get("B09RPRRNVP");
  assert.equal(rag.sizeEvidence(product,"8.5","US").price,null);
  assert.equal(rag.sizeEvidence(product,"8.5","UK").kind,"chart");
});
test("inclusive, exclusive and combined budgets use cents",()=>{
  assert(ask("女士鞋 6.99 美元以内").cards.some(c=>c.price===699));
  assert(ask("找低于 6.99 美元的女士鞋").cards.every(c=>c.price<699));
  const out = ask("找三件美妆，合计预算20美元以内，给出图片");
  assert(out.cards.length && out.cards.reduce((n,c)=>n+c.price,0)<=2000);
  assert(out.notes.some(n=>n.includes("合计")));
});
test("compatibility and live evidence avoid unsupported claims",()=>{
  const search = ask("找 30 美元以内适配 iPhone 13 的手机壳，给我图片并说明兼容性。");
  assert(search.cards.every(c=>!/\biPhone (?:11|12)\b/i.test(c.name)));
  assert.equal(rag.compatibility({compatibility:["Compatible with iPhone 13 Pro Max"]},"iPhone 13").status,"unconfirmed");
  assert.equal(rag.compatibility({compatibility:["Not compatible with iPhone 13"]},"iPhone 13").status,"incompatible");
  const out = ask("B09RPRRNVP 的当前价格、库存和商品图");
  assert.equal(out.cards[0].id,"B09RPRRNVP");
  assert(out.notes.some(n=>n.includes("实时售价")));
  assert(out.cards[0].gaps.some(n=>n.includes("当前库存")));
});
test("invalid references and unknown ASINs return useful empty results",()=>{
  const missing = ask("介绍第9款的材质",browse().state);
  assert.equal(missing.cards.length,0);
  assert(missing.notes.some(x=>x.includes("没有第 9 款")));
  assert(!ask("查 B000000000 的价格").cards.length);
});
test("cloud planner preserves locally recognized hard constraints",()=>{
  const cloud = rag.makePlan({category:"beauty",max_price:200,tasks:["image"],terms:[]});
  const out = ask("从美妆个护找25美元以内的商品",{},cloud);
  assert(out.cards.length && out.cards.every(c=>c.price<=2500 && c.images.length));
  assert.throws(()=>ask("查询",{},{}),/Invalid planner output/);
});
test("splits have unique full inputs and isolated ASIN families and contexts",()=>{
  const dir = path.join(__dirname,"../data/sft");
  const assigned = JSON.parse(fs.readFileSync(path.join(dir,"asin-splits.json"),"utf8"));
  const groups = new Map(), inputs = new Set();
  for (const {group,split} of Object.values(assigned)) {
    assert.equal(groups.get(group) || split,split);
    groups.set(group,split);
  }
  for (const [split,len] of [["train",1246],["validation",156],["test",156]]) {
    const rows = fs.readFileSync(path.join(dir,split+".jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length,len);
    assert(rows.some(row=>row.expected.shoe));
    for (const row of rows) {
      assert(!inputs.has(row.messages[1].content));
      inputs.add(row.messages[1].content);
      for (const id of row.products) assert.equal(assigned[id].split,split);
    }
  }
});
