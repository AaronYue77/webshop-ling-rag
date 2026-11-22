const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname,"..");
require("../web/catalog");
const {products,meta} = globalThis.ShopCatalog;
const policy = require("../web/policy");
const {makePlan,labels,sizeOptions,colorOptions} = require("../web/rag");
const out = path.join(root,"data","sft");
fs.mkdirSync(out,{recursive:true});
const digest = str=>crypto.createHash("sha256").update("webshop-v1:"+str).digest("hex");
const parents = new Map(products.map(p=>[p.id,p.id]));
function find(id) {
  if (parents.get(id) !== id) parents.set(id,find(parents.get(id)));
  return parents.get(id);
}
function join(a,b) {
  const x=find(a), y=find(b);
  if (x !== y) parents.set(x < y ? y : x,x < y ? x : y);
}
const title = p=>p.name.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const familyTitle = p=>title(p).replace(/\b(?:black|white|blue|red|green|pink|grey|gray|yellow|brown|purple|cream|tan|silver|gold|navy|beige|orange|small|medium|large)\b/g,"").replace(/\s+/g," ").trim();
const concrete = text=>new Set(text.split(" ").filter(w=>w.length > 2));
const variants = new Map(), exactTitles = new Map();
for (const p of products) {
  const key = familyTitle(p);
  if (exactTitles.has(key)) join(p.id,exactTitles.get(key));
  else exactTitles.set(key,p.id);
  for (const option of Object.values(p.variants).flat()) {
    if (!option.asin) continue;
    if (parents.has(option.asin)) join(p.id,option.asin);
    if (variants.has(option.asin)) join(p.id,variants.get(option.asin));
    else variants.set(option.asin,p.id);
  }
}
for (let i=0;i<products.length;i++) {
  const a = products[i], aTerms=concrete(familyTitle(a));
  for (const b of products.slice(i+1)) {
    if (a.category !== b.category || !a.brand || a.brand.toLowerCase() !== b.brand.toLowerCase()) continue;
    const bTerms = concrete(familyTitle(b));
    const common = [...aTerms].filter(x=>bTerms.has(x)).length;
    const sharePrefix = familyTitle(a).split(" ").slice(0,5).join(" ") === familyTitle(b).split(" ").slice(0,5).join(" ");
    if (common >= 5 && common/(aTerms.size+bTerms.size-common) >= (sharePrefix ? .55 : .82)) join(a.id,b.id);
  }
}
const grouped = new Map();
for (const p of products) {
  const key = find(p.id);
  if (!grouped.has(key)) grouped.set(key,[]);
  grouped.get(key).push(p);
}
const quotas = {
  beauty:{train:177,validation:22,test:22}, electronics:{train:163,validation:20,test:20},
  fashion:{train:50,validation:6,test:7}, garden:{train:156,validation:20,test:20}, grocery:{train:77,validation:10,test:9}
};
const splits = {train:[],validation:[],test:[]};
const room = structuredClone(quotas);
const groups = [...grouped].sort(([a,x],[b,y])=>y.length-x.length || digest(a).localeCompare(digest(b)));
const reserved = new Map();
const eligibleShoes = groups.filter(([,group])=>group.length === 1 && group[0].shoe && group[0].audience === "women" &&
  sizeOptions(group[0]).some(v=>/^\d{1,2}(?:\.\d)?$/.test(v.value)));
if (eligibleShoes.length < 5) throw Error("Need at least five women's shoe records for representation in all splits");
for (const [i,[id]] of eligibleShoes.slice(0,4).entries()) reserved.set(id,i%2 ? "test" : "validation");
for (const [id,group] of groups) {
  const counts = {};
  for (const p of group) counts[p.category] = (counts[p.category] || 0) + 1;
  const candidates = Object.keys(splits).filter(s=>(!reserved.has(id) || reserved.get(id) === s) && Object.keys(counts).every(k=>counts[k] <= room[k][s]));
  if (!candidates.length) throw Error("Unable to keep variant group "+id+" intact within the configured quotas");
  const split = candidates.sort((a,b)=>{
    const need = s=>Object.keys(counts).reduce((sum,k)=>sum+room[k][s]/quotas[k][s],0);
    return need(b)-need(a) || digest(id+a).localeCompare(digest(id+b));
  })[0];
  splits[split].push(...group);
  for (const [k,n] of Object.entries(counts)) room[k][split] -= n;
}
const categoriesEN = {beauty:"beauty and personal care",electronics:"electronics",fashion:"fashion",garden:"home and garden",grocery:"groceries"};
const budgetFor = p=>Math.max(5,Math.ceil(p.price/500)*5);
const contextFor = (items,active = null)=>({previousResults:items.map((p,i)=>({position:i+1,id:p.id,name:p.name.slice(0,140)})),active});
const row = (id,products,question,plan,context = {},family) => ({
  id,products,question,context,family,expected:makePlan(plan),
  messages:[{role:"system",content:policy.SYSTEM},{role:"user",content:policy.message(question,context)},{role:"assistant",content:JSON.stringify(makePlan(plan))}]
});
const wording = {
  train:{
    lookup:[p=>p.id+" 这款有图吗？也想查一下历史价格。",p=>"Please show a photo and past pricing for ASIN "+p.id+".",p=>"拿 "+p.id+" 的目录图片和价格记录给我看看。"],
    budget:[(p,b)=>"从"+labels[p.category]+"里选 3 件不超过 "+b+" 美元的商品，附图并解释怎么选。",(p,b)=>"Pick three "+categoriesEN[p.category]+" items under $"+b+" each. Include photos and why you picked them.",(p,b)=>"在"+labels[p.category]+"目录给我找三样，单价上限 "+b+" 美元，想看看商品图和推荐理由。"],
    shoe:[(p,b,s)=>"给我找"+(p.audience==="women"?"女士":"男士")+"鞋，"+s+" 码，"+b+" 美元以内。要图片和颜色。",(p,b,s)=>"Show "+(p.audience==="women"?"women's":"men's")+" shoes in US "+s+" up to $"+b+" with pictures and colors."],
    detail:[n=>"介绍第 "+n+" 款的颜色、材质和规格，没写的也告诉我。",n=>"Which colors, materials and specs are on record for item #"+n+"?",n=>"第"+n+"件的配色、面料、参数各是什么？"],
    compare:[(a,b)=>"比较第 "+a+" 款和第 "+b+" 款，哪个更便宜？差多少钱？主要区别是什么？",(a,b)=>"Compare item #"+a+" vs #"+b+": which costs less, by how much, and how do their specs differ?"],
    variant:[n=>"刚才第 "+n+" 款有哪些尺码？尺码各自的价格有吗？",n=>"For item #"+n+", list the recorded sizes and the price per size."],
    current:[n=>"第 "+n+" 款现在多少钱，有库存吗？",n=>"What's the current price and stock of item #"+n+"?"],
    reason:[n=>"我更喜欢第 "+n+" 款。结合它的属性说明推荐理由和要确认的地方。",n=>"I'm leaning toward item #"+n+". Give reasons based on the product attributes and what should I confirm."],
    fit:[(n,t)=>"帮我确认第 "+n+" 款能否适配 "+t+"。",(n,t)=>"Does item #"+n+" work with "+t+"?"],
    active:[()=>"这款还有哪些颜色与规格？",()=>"What other colors and specs are recorded for this one?"]
  },
  validation:{
    lookup:[p=>"给 ASIN "+p.id+" 配张商品图，历史价格也一并查一下。"],
    budget:[(p,b)=>"给一份三件的"+labels[p.category]+"清单，每件最多 "+b+" 美金，配图并写选购依据。"],
    shoe:[(p,b,s)=>"Look for "+(p.audience==="women"?"ladies'":"men's")+" footwear, US "+s+", at most $"+b+". I need photos and color options."],
    detail:[n=>"轮到清单第"+n+"项了，想核对配色、原材料与规格。"],
    compare:[(a,b)=>"What is the price gap between #"+a+" and #"+b+" in the prior list, and how do their specifications differ?"],
    variant:[n=>"我在看第"+n+"件。把已记录尺码和每码金额放在一起。"],
    current:[n=>"请查清单第"+n+"件的现价，并核实现货。"],
    reason:[n=>"Give me a product-specific reason to choose item #"+n+" and any details that I should confirm."],
    fit:[(n,t)=>"Check compatibility evidence for the option in position #"+n+" with "+t+"."],
    active:[()=>"前面选中的那件，配色与参数再整理一下。"]
  },
  test:{
    lookup:[p=>"我手边只有编号 "+p.id+"；请从目录给我看商品照片，再说说过去的标价。"],
    budget:[(p,b)=>"想逛"+labels[p.category]+"，帮我挑三件。每样最多花 "+b+" 美元，想先看图和你的选购理由。"],
    shoe:[(p,b,s)=>"在 "+b+" 美金以内找"+(p.audience==="women"?"女式":"男式")+"鞋款；我穿 US "+s+"，想看配色与图。"],
    detail:[n=>"我正在考虑第"+n+"件，具体是什么面料、都有什么颜色，规格写了哪些？"],
    compare:[(a,b)=>"把 #"+a+" 和 #"+b+" 放一起看，预算差多少，两件规格有何不同？"],
    variant:[n=>"第"+n+"个可选尺寸是哪些？每个尺码的报价有明细吗？"],
    current:[n=>"如果现在下单，第"+n+"项的实际到手价和是否有货能确认吗？"],
    reason:[n=>"如果选前一轮的第"+n+"件，哪些产品细节支持这个选择，还有什么需要核实？"],
    fit:[(n,t)=>"我用的是 "+t+"。前一批的第"+n+"个可以搭配这个型号吗？"],
    active:[()=>"刚才打开的商品再帮我查看颜色版本和尺寸参数。"]
  }
};
function generate(split,items) {
  const rows = [];
  const language = wording[split];
  const budgetQuestions = new Set();
  const population = items.sort((a,b)=>digest(a.id).localeCompare(digest(b.id)));
  for (const [i,p] of population.entries()) {
    const others = population.filter(x=>x.id !== p.id && x.category === p.category);
    const temp = [p,others[(i*3)%others.length],others[(i*3+1)%others.length]];
    const rotation = i%3;
    const prior = [...temp.slice(rotation),...temp.slice(0,rotation)];
    const ord = prior.findIndex(x=>x.id === p.id) + 1;
    const context = contextFor(prior);
    const ids = prior.map(x=>x.id);
    const select = (kind,...args)=>language[kind][i%language[kind].length](...args);
    const shoeSize = sizeOptions(p).map(v=>v.value).find(v=>/^\d{1,2}(?:\.\d)?$/.test(v));
    let b = budgetFor(p);
    if (p.shoe && ["women","men"].includes(p.audience) && shoeSize) {
      rows.push(row(p.id+"-search",[p.id],select("shoe",p,b,shoeSize),
        {shoe:true,audience:p.audience,size:shoeSize,size_system:"US",max_price:b,tasks:["image","color","size"]},{},"shoe"));
    } else if (i%2) {
      while (budgetQuestions.has(select("budget",p,b))) b = Number((b+.25).toFixed(2));
      const question = select("budget",p,b);
      budgetQuestions.add(question);
      rows.push(row(p.id+"-search",[p.id],question,
        {category:p.category,max_price:b,price_exclusive:split==="train" && i%3===1,tasks:["image","recommend"],limit:3},{},"budget"));
    } else {
      rows.push(row(p.id+"-search",[p.id],select("lookup",p),
        {terms:[p.id],tasks:["image","price","price_history"]},{},"lookup"));
    }
    const family = ["detail","compare","variant","current","reason","fit","active"][i%7];
    const other = ord%3+1;
    const target = ["iPhone 13","Samsung Galaxy S22","Nintendo Switch","USB-C","MacBook Air","Pixel 8"][i%6];
    const tasks = {
      detail:["color","material","specs"],compare:["compare","price","specs"],variant:["size","price","variant_price"],
      current:["current_price","price","inventory"],reason:["recommend"],fit:["compatibility"],active:["color","specs"]
    };
    const question = family==="compare" ? select(family,ord,other) : family==="fit" ? select(family,ord,target) : select(family,ord);
    const contextWithActive = family==="active" ? contextFor(prior,ord) : context;
    const plan = {action:family==="compare"?"compare":"detail",tasks:tasks[family],refs:family==="compare"?[ord,other]:[ord]};
    if (family==="fit") plan.compatibility_target = target;
    rows.push(row(p.id+"-follow",ids,question,plan,contextWithActive,family));
  }
  return rows;
}
const manifest = {seed:"webshop-v1",catalogSHA256:meta.sha256,groupCount:groups.length,variantGroups:groups.filter(([,group])=>group.length>1).length,split:{}};
const assignment = {};
for (const [split,items] of Object.entries(splits)) {
  const rows = generate(split,items);
  fs.writeFileSync(path.join(out,split+".jsonl"),rows.map(r=>JSON.stringify(r)).join("\n")+"\n");
  const counts = {};
  for (const r of rows) counts[r.family] = (counts[r.family] || 0) + 1;
  for (const p of items) assignment[p.id] = {split,group:find(p.id)};
  manifest.split[split] = {products:items.length,questions:rows.length,uniqueInputs:new Set(rows.map(r=>r.messages[1].content)).size,
    categories:Object.fromEntries(Object.entries(quotas).map(([key,value])=>[key,value[split]])),families:counts};
}
fs.writeFileSync(path.join(out,"asin-splits.json"),JSON.stringify(assignment,null,2)+"\n");
const exampleProducts = splits.test.filter(p=>p.category==="fashion").slice(0,4);
const prior = contextFor(exampleProducts), active = contextFor(exampleProducts,2);
const detail = (n,tasks,extra={})=>({action:"detail",refs:[n],tasks,...extra});
const comparison = (a,b)=>({action:"compare",refs:[a,b],tasks:["compare","price","specs"]});
const challenges = [
  ["我想给女朋友买一双8.5码的女士鞋，预算50美元以内。请给我图片、历史价格和推荐理由，并列出颜色与尺码信息。",
    {shoe:true,audience:"women",size:"8.5",size_system:"US",max_price:50,tasks:["image","price","price_history","recommend","color","size"]}],
  ["目录里有哪些女士鞋款？给我看看图片、历史价格和已记录的尺码。",
    {shoe:true,audience:"women",limit:12,tasks:["image","price","price_history","size"]}],
  ["从美妆个护里挑几件25美元以内的商品，给我图片，并说明怎么选。",
    {category:"beauty",max_price:25,tasks:["image","recommend"]}],
  ["介绍第三款的颜色、材质和规格，资料缺失的地方也告诉我。",detail(3,["color","material","specs"]),prior],
  ["第一款和第三款哪个更便宜？差多少钱？它们的主要区别是什么？",comparison(1,3),prior],
  ["刚才第二款记录了哪些尺码？这些尺码有各自的价格吗？",detail(2,["size","price","variant_price"]),prior],
  ["我比较喜欢第一款。结合它的具体属性，说说选择它的理由和还需要确认的信息。",detail(1,["recommend"]),prior],
  ["这款现在是不是有货？能确认实时售价吗？",detail(2,["inventory","price","current_price"]),active],
  ["给我看 3 件 20 美元以下的电子数码商品，按价格从高到低列出来。",
    {category:"electronics",max_price:20,limit:3,sort:"price_desc",tasks:["price"]}],
  ["两件美妆加起来预算 18 美元，想先看照片和推荐理由。",
    {category:"beauty",max_price:18,budget_scope:"total",limit:2,tasks:["image","recommend"]}],
  ["找黑色、UK 7 的男鞋，低于 40 美元，附照片。",
    {shoe:true,audience:"men",color:"black",size:"7",size_system:"UK",max_price:40,price_exclusive:true,tasks:["image","size"]}],
  ["我准备用欧码 39 选女士凉鞋，想要商品图片和尺寸表。",
    {shoe:true,audience:"women",size:"39",size_system:"EU",terms:["sandals"],tasks:["image","size","specs"]}],
  ["Show me grocery items between 10 and 22 dollars, cheapest first, with photos.",
    {category:"grocery",min_price:10,max_price:22,sort:"price_asc",tasks:["image"]}],
  ["有没有适配 iPhone 13 的手机壳？从数码挑 2 款单价不超过 30 美元并给出图片。",
    {category:"electronics",max_price:30,compatibility_target:"iPhone 13",terms:["phone case"],limit:2,tasks:["compatibility","image"]}],
  ["前一轮第 2 件配 Nintendo Switch 可不可以，确认依据在哪？",
    detail(2,["compatibility"],{compatibility_target:"Nintendo Switch"}),prior],
  ["Show me three coffee options under $15 per item. Include pictures and a selection rationale.",
    {max_price:15,price_exclusive:true,terms:["coffee"],limit:3,tasks:["image","recommend"]}],
  ["第三件的各个颜色有没有分别标价？",detail(3,["color","price","variant_price"]),prior],
  ["第 1 件过去三个月降价了吗？顺便核实今天库存。",detail(1,["price_history","price","inventory"]),prior],
  ["What is the material of the previously selected item? Any catalog dimensions?",detail(2,["material","specs"]),active],
  ["请改搜家居园艺，展示前五件并给图，预算最多 60 美元。",{category:"garden",max_price:60,limit:5,tasks:["image"]},prior],
  ["比较第二和第四款，主要差别与目录价分别是多少？",comparison(2,4),prior],
  ["哪个颜色更适合搭配？先列出第 2 款的颜色，给我图片。",detail(2,["color","image","recommend"]),prior],
  ["Do you have any face masks below $12 with images?",{max_price:12,price_exclusive:true,terms:["face mask"],tasks:["image"]}],
  ["推荐 2 个 100 美元以内的咖啡桌，讲讲材质和规格，给出商品照片。",
    {max_price:100,terms:["coffee table"],limit:2,tasks:["recommend","material","specs","image"]}]
];
const challengeRows = challenges.map(([q,p,c],i)=>row("challenge-"+(i+1),c ? exampleProducts.map(x=>x.id) : [],q,p,c,"manual"));
fs.writeFileSync(path.join(out,"challenge.jsonl"),challengeRows.map(r=>JSON.stringify(r)).join("\n")+"\n");
manifest.challenge = {questions:challengeRows.length,contextSplit:"test",construction:"manual"};
fs.writeFileSync(path.join(out,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
console.log(JSON.stringify(manifest,null,2));
