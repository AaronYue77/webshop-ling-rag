(function (root, factory) {
  const engine = factory(typeof module === "object" ? require("./policy.js") : root.ShopPolicy);
  if (typeof module === "object") module.exports = engine;
  else root.ShopRag = engine;
})(globalThis, function (policy) {
  const labels = {beauty:"美妆个护", electronics:"电子数码", fashion:"服饰鞋包", garden:"家居园艺", grocery:"食品杂货"};
  const taskLabels = {image:"展示图片",price:"核对目录价",price_history:"核对历史价格",size:"核对尺码",color:"核对颜色",material:"核对材质",specs:"查看规格",recommend:"解释选择",compare:"对比商品",variant_price:"核对选项价格",inventory:"核对库存",compatibility:"核对适用性",current_price:"核对现价"};
  const priceHistoryNote = "目录只记录了未标注日期的价格快照，缺少按日期排列的历史价格或涨跌趋势。";
  const types = [
    [/防晒/,"sunscreen"],[/面霜|保湿霜/,"face moisturizer"],[/面膜/,"face mask"],[/洗面奶|洁面/,"facial cleanser"],
    [/洗发[水露]|洗头/,"shampoo"],[/护发素/,"conditioner"],[/口红|唇膏/,"lipstick balm"],[/香水/,"perfume"],
    [/眼影/,"eyeshadow"],[/睫毛膏/,"mascara"],[/牙刷/,"toothbrush"],[/护肤/,"skin care"],
    [/运动鞋|跑鞋/,"running sneakers"],[/凉鞋/,"sandals"],[/拖鞋/,"slippers"],[/靴子|短靴/,"boots booties"],
    [/平底鞋/,"ballet flats"],[/走路鞋|健走鞋/,"walking shoes"],
    [/充电[线器]|数据线|充电头/,"charger charging cable"],[/耳机/,"headphones earbuds"],[/键盘/,"keyboard"],
    [/显示器/,"monitor"],[/蓝牙音箱|扬声器/,"speaker bluetooth"],[/鼠标/,"mouse"],[/手机壳|保护壳/,"phone case cover"],
    [/转接[器头]|适配器/,"adapter"],[/插座/,"power outlet"],[/咖啡/,"coffee"],[/巧克力/,"chocolate"],
    [/零食/,"snack"],[/绿茶/,"green tea"],[/红茶/,"black tea"],[/橄榄油/,"olive oil"],[/饼干/,"cookies biscuits"],
    [/花盆/,"planter pot"],[/浇水|灌溉/,"watering irrigation"],[/台灯/,"desk lamp"],[/沙发桌|玄关桌/,"console table"],
    [/咖啡桌|茶几/,"coffee table"],[/收纳/,"storage"],[/椅子/,"chair"],[/水壶/,"water bottle kettle"],[/瑜伽垫/,"yoga mat"],[/背包/,"backpack"],
    [/连衣裙/,"dress"],[/外套/,"coat jacket"],[/袜子/,"socks"],[/裤子/,"pants"],[/太阳镜/,"sunglasses"]
  ];
  const categoryPatterns = {
    beauty:/美妆|个护|beauty|personal care/i, electronics:/电子数码|电子产品|数码|electronics/i,
    fashion:/服饰|鞋包|fashion|clothing/i, garden:/家居|园艺|garden|home & kitchen/i, grocery:/食品|杂货|grocery/i
  };
  const colors = {黑:"black",白:"white",红:"red",粉:"pink",蓝:"blue",灰:"gray",绿:"green",棕:"brown",紫:"purple",黄:"yellow",米:"beige",银:"silver",金:"gold",橙:"orange",裸:"nude"};
  const cn = {一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,十一:11,十二:12};
  const ordinals = {first:1,second:2,third:3,fourth:4,fifth:5,sixth:6,seventh:7,eighth:8,ninth:9,tenth:10,eleventh:11,twelfth:12};
  const unique = values => [...new Set(values)];
  const strip = value => String(value ?? "").normalize("NFKC").trim();
  const oneOf = (v, options, fallback = null) => options.includes(v) ? v : fallback;
  const validPrice = x => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100000 ? x : null;
  const word = value => strip(value).toLowerCase().replace(/\bgrey\b/g,"gray").replace(/[’']/g,"");
  const tokens = value => (word(value).match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g) || []).map(x => {
    if (/ies$/.test(x) && x.length > 4) return x.slice(0,-3)+"y";
    return /[^s]s$/.test(x) && x.length > 3 ? x.slice(0,-1) : x;
  });
  const money = cents => cents == null ? "未记录" : "$" + (cents/100).toFixed(2);
  const stop = new Set(tokens("i me my we you the and or of on in for to can could please help show find give choose get buy want need a an with from it these those this that what which how some few more only each per list catalog product item picture photo image historical history price current live stock available size color material specification spec recommend reason compare cheap cheaper cheapest difference under dollars usd budget within below at least total does work compatible support first second third fourth fifth sixth womens women mens men kids girl girlfriend boy boyfriend shoe shoes beauty electronics fashion clothing garden grocery personal care footwear lady girls pick describe tell option variant about confirm information fit between is are numbers previous last one recorded respective listing today all any have there possible also cost or not off works reviews amazon"));
  function makePlan(v = {}) {
    return {
      action:oneOf(v.action,["search","detail","compare"],"search"),
      tasks:unique(Array.isArray(v.tasks) ? v.tasks.filter(x=>policy.TASKS.includes(x)) : []),
      category:oneOf(v.category,policy.CATEGORIES), shoe:v.shoe === true, audience:oneOf(v.audience,["women","men","kids"]),
      max_price:validPrice(v.max_price), min_price:validPrice(v.min_price), price_exclusive:v.price_exclusive === true,
      size:typeof v.size === "string" && /^[\w .+/-]{1,30}$/.test(v.size) ? v.size.trim() : null,
      size_system:oneOf(v.size_system,["US","UK","EU"]),
      color:typeof v.color === "string" && /^[a-z -]{2,30}$/i.test(v.color) ? word(v.color) : null,
      terms:unique((Array.isArray(v.terms) ? v.terms : []).filter(x=>typeof x === "string" && /^[\w .+/'-]{1,55}$/.test(x)).map(strip).filter(Boolean)).slice(0,12),
      refs:unique(Array.isArray(v.refs) ? v.refs.filter(x=>Number.isInteger(x) && x >= 1 && x <= 100) : []).slice(0,12),
      limit:Number.isInteger(v.limit) ? Math.min(12,Math.max(1,v.limit)) : 4,
      compatibility_target:typeof v.compatibility_target === "string" ? strip(v.compatibility_target).slice(0,130) || null : null,
      sort:oneOf(v.sort,["relevance","price_asc","price_desc"],"relevance"),
      budget_scope:oneOf(v.budget_scope,["item","total"],"item")
    };
  }
  function localPlan(question, state = {}) {
    const q = strip(question);
    const refs = unique([
      ...[...q.matchAll(/第\s*(十一|十二|[一二两三四五六七八九十]|\d{1,2})\s*(?:款|件|个|双|项|条)?/g)].map(m=>Number(m[1]) || cn[m[1]]),
      ...[...q.matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\b|(?:#|item\s+)(\d{1,2})\b/gi)].map(m=>ordinals[m[1]?.toLowerCase()] || Number(m[2])),
      ...[...q.matchAll(/(?:对比|比较)\s*(\d{1,2})\s*(?:和|与|、|\/|vs\.?)\s*(\d{1,2})/gi)].flatMap(m=>[Number(m[1]),Number(m[2])])
    ]);
    const tasks = [];
    const has = (key,re) => { if (re.test(q)) tasks.push(key); };
    has("image",/图[片像]|配图|看看图|照片|附图|pictures?|photos?|images?/i);
    has("price_history",/历史.{0,3}(?:价|售价)|价格[走势趋变]|过去.*(?:价|钱)|涨价|降价|historical|price history|price trend/i);
    has("current_price",/现价|(?:现在|当前|实时|今日|今天|实际到手).{0,14}(?:价|多少钱)|current price|today.s price|live price/i);
    has("price",/价格|目录价|价位|售价|花费|多少钱|便宜|price|cost|cheaper/i);
    has("size",/尺码|几码|\d\s*码|\bsizes?\b|\b(?:US|UK|EU)\s*\d/i);
    has("color",/颜色|色号|配色|colou?rs?/i);
    has("material",/材质|面料|成分|materials?|fabric|ingredients/i);
    has("specs",/规格|尺寸|参数|重量|容量|区别|差异|specs?|specifications?|dimensions?|weight|differences?/i);
    has("recommend",/推荐|理由|怎么选|如何选|适合我|值得|为什么|还需.*确认|recommend|why|which should|how to choose/i);
    has("compare",/对比|比较(?!喜欢)|差多少钱|哪个更便宜|\bcompare\b|cheaper|price difference|\bvs\.?\b/i);
    has("variant_price",/各自.*(?:价|钱)|独立.*(?:价|钱)|选项.*价|每个.*(?:价|钱)|分尺码.*(?:价|钱)|不同.*尺码.*价|(?:size|variant|option).{0,18}price|price.{0,12}per (?:size|option|variant)/i);
    has("inventory",/库存|现货|有没有货|有货|还剩|到货|in stock|inventory|stock|available now/i);
    has("compatibility",/兼容|通用|能否.{0,25}用|能给.{1,25}用|能用在|适配|compatib|work with|works with|fit my|supports?\b/i);
    const category = Object.keys(categoryPatterns).find(k=>categoryPatterns[k].test(q));
    const shoe = /鞋(?!柜|架|盒|带|油|垫)|凉拖|短靴|靴子|\b(?:shoes?|footwear|boots?|sneakers?|sandals?|slippers?|loafers?|flats?)\b/i.test(q);
    const audience = /女士|女[朋友鞋款]|女性|女友|送她|女生|\bwomen'?s?\b|\bgirlfriend\b|\blad(?:y|ies)\b/i.test(q) ? "women" :
      /男士|男[式朋友鞋款]|男性|男友|男生|\bmen'?s?\b|\bboyfriend\b/i.test(q) ? "men" :
      /儿童|小孩|童鞋|男童|女童|\bkids?\b|\bchildren\b/i.test(q) ? "kids" : null;
    const sm = /(?:(US|UK|EU|美码|英码|欧码)\s*[-:]?\s*(\d{1,2}(?:\.\d+)?)(?:\s?(Wide|[A-DW]{1,2})\b)?|(?:size|尺码)\s*[:：]?\s*(\d{1,2}(?:\.\d+)?)(?:\s?(Wide|[A-DW]{1,2})\b)?|(\d{1,2}(?:\.\d+)?)\s*码)/i.exec(q);
    const apparelSize = /(?:尺码|size)\s*[:：]?\s*(XS|XXL|XL|[SML])\b|\b(XS|XXL|XL|[SML])\s*码/i.exec(q);
    const systemText = sm?.[1]?.toUpperCase();
    const size = sm ? (sm[2] || sm[4] || sm[6]) + (sm[3] || sm[5] || "") : apparelSize?.[1] || apparelSize?.[2] || null;
    if (size && !tasks.includes("size")) tasks.push("size");
    const colorKey = Object.keys(colors).find(key=>q.includes(key+"色"));
    const color = colorKey ? colors[colorKey] : /\b(black|white|red|pink|blue|gr[ae]y|green|brown|purple|yellow|beige|silver|gold|orange|nude)\b/i.exec(q)?.[1];
    const foreignCurrency = /人民币|欧元|英镑|日元|港币|[¥￥€£]|\b(?:CNY|RMB|EUR|GBP|JPY|HKD|CAD|AUD)\b/i.test(q);
    const range = /(?:\$\s*)?(\d+(?:\.\d+)?)\s*(?:美元|USD|dollars?)?\s*(?:到|至|[–—-]|\band\b)\s*(?:\$\s*)?(\d+(?:\.\d+)?)\s*(?:美元|USD|dollars?)/i.exec(q);
    const dollar = /(?:\$\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:美元|美金|USD\b|dollars?\b))/i.exec(q);
    const shorthand = /(?:预算|不超过|低于|小于|最多)\s*(\d+(?:\.\d+)?)/i.exec(q);
    const amount = dollar || shorthand;
    const budget = /预算|不超过|以内|以下|低于|至多|小于|上限|最多|under|within|below|budget|up to|at most|less than/i.test(q);
    const min = /至少|以上|高于|起步|at least|above|over/i.test(q);
    const compatTarget = tasks.includes("compatibility") ?
      /(?:iPhone|iPad|Galaxy|Pixel|MacBook|ThinkPad|Nintendo Switch|PlayStation|PS[45]|Xbox|USB[- ]?C|Lightning)(?:\s*(?:\d{1,4}|Pro Max|Pro|Plus|Mini|Air|OLED|Ultra|Series [XS])){0,3}/i.exec(q)?.[0]?.trim() ||
      /(?:work(?:s)? with|compatible with|适配|兼容)\s*([A-Za-z0-9][A-Za-z0-9 .-]{1,35})/i.exec(q)?.[1]?.trim() : null;
    const take = /(?:前|挑|选|看|展示|推荐|找|给(?:我)?)\s*(十二|十一|[一二两三四五六七八九十]|\d{1,2})\s*(?:款|件|个|双|项)|^(两|三|四|五|\d{1,2})\s*(?:款|件|个|双)|\b(\d{1,2}|two|three|four|five)\s+(?:items|options|products|pairs|results|coffee options)\b/i.exec(q);
    const all = /有哪些|全部|所有|whole|all (?:the )?(?:catalog|products|shoes)/i.test(q);
    const english = (q.match(/[a-zA-Z][a-zA-Z0-9.+-]*/g) || []).filter(x=>{
      const [t] = tokens(x);
      return t && !stop.has(t) && !["us","uk","eu","usd","s","m","l","xl","xxl","xs"].includes(t) && !Object.values(colors).includes(t);
    });
    const browseAnother = /改搜|再找|再看|重新|换一批|另外推荐|其他商品|search again|more products/i.test(q);
    const previousGroup = state.resultIds?.length && /(?:这|那|上面(?:的)?|刚才(?:的)?)([一二两三四五六七八九十\d]{1,2}|几|些)?(?:款|件|双)|\b(?:these|those)\s+(?:(?:two|three|four|five|\d+)\s+)?(?:items|products|pairs|shoes)\b/i.exec(q);
    if (!browseAnother && !refs.length && previousGroup && !/^(?:这款|那款|这件|那件|这双|那双)$/.test(previousGroup[0])) {
      const count = Number(previousGroup[1]) || cn[previousGroup[1]] || state.resultIds?.length || 0;
      refs.push(...(state.resultIds || []).slice(0,count).map((_, index)=>index+1));
    }
    const follow = !browseAnother && (previousGroup || /\b(?:it|that one|these|previous)\b|刚才|这款|那款|它(?:的|有哪些|能|是什么)|上款|继续核对|还需/i.test(q));
    const detail = !browseAnother && (refs.length > 0 || follow);
    const n = x=>x === undefined ? null : Number(String(x).replace(/,/g,""));
    const plan = makePlan({
      action:tasks.includes("compare") && (refs.length || state.resultIds?.length) ? "compare" : detail ? "detail":"search",
      tasks,category,shoe,audience,size,size_system:systemText ? ({"美码":"US","英码":"UK","欧码":"EU"}[systemText] || systemText) : shoe && size ? "US" : null,
      max_price:!foreignCurrency && range ? n(range[2]) : !foreignCurrency && budget && amount ? n(amount[1] || amount[2]) : null,
      min_price:!foreignCurrency && range ? n(range[1]) : !foreignCurrency && min && amount ? n(amount[1] || amount[2]) : null,
      price_exclusive:/低于|小于|(?:under|below|less than)\b/i.test(q),color,
      terms:unique([...types.filter(([rx])=>rx.test(q)).flatMap(([,value])=>value.split(" ")),...english]),
      refs,limit:take ? (Number(take[1] || take[2] || take[3]) || cn[take[1] || take[2]] || {two:2,three:3,four:4,five:5}[take[3]?.toLowerCase()]) : all ? 12 : 4,
      sort:/从低到高|最便宜|cheapest|lowest price/i.test(q) ? "price_asc" : /从高到低|最贵|most expensive|highest price/i.test(q) ? "price_desc" : "relevance",
      compatibility_target:compatTarget,
      budget_scope:/总[价预共计]|合计|一共|加起来|一起.{0,6}(?:美元|预算)|total|combined|altogether/i.test(q) ? "total":"item"
    });
    return {plan,foreignCurrency};
  }
  function validatedPlan(remote) {
    if (!remote || typeof remote !== "object" || !["search","detail","compare"].includes(remote.action) ||
        !Array.isArray(remote.tasks) || !Array.isArray(remote.terms) || !Array.isArray(remote.refs)) throw Error("Invalid planner output");
    const plan = makePlan(remote);
    for (const key of ["required_terms","excluded_terms"]) {
      if (!Object.hasOwn(remote,key)) continue;
      const list = remote[key];
      if (!Array.isArray(list) || list.length > 8 || list.some(value=>
        typeof value !== "string" || value.length > 55 || !tokens(value).length)) throw Error("Invalid planner evidence filters");
      plan[key] = unique(list.map(strip));
    }
    return plan;
  }
  function mergePlan(local, remote) {
    const cloud = validatedPlan(remote);
    const result = {...cloud,tasks:unique([...local.tasks,...cloud.tasks])};
    for (const key of ["category","audience","size","size_system","color","max_price","min_price","compatibility_target"]) if (local[key] !== null) result[key] = local[key];
    if (local.max_price !== null) result.price_exclusive = local.price_exclusive;
    if (local.shoe) result.shoe = true;
    if (local.limit !== 4) result.limit = local.limit;
    if (local.sort !== "relevance") result.sort = local.sort;
    if (local.budget_scope === "total") result.budget_scope = "total";
    if (local.action !== "search" || local.refs.length) result.action = local.action;
    if (local.refs.length) result.refs = local.refs;
    result.terms = unique([...cloud.terms,...local.terms]).slice(0,12);
    return result;
  }
  function sizeOptions(p) {
    return Object.entries(p.variants).filter(([key])=>/\bsize\b/i.test(key)).flatMap(([,values])=>values);
  }
  function colorOptions(p) {
    const values = Object.entries(p.variants).filter(([key])=>/colou?r/i.test(key)).flatMap(([,v])=>v);
    if (p.specs.Color && !values.some(x=>word(x.value) === word(p.specs.Color))) values.push({value:p.specs.Color,price:null});
    return values;
  }
  function sizeEvidence(p, size, system) {
    if (!size) return {kind:"none"};
    const compact = x=>word(x).replace(/\s+/g,"");
    const target = compact(size);
    const chosen = system || (p.shoe && /^\d/.test(size) ? "US" : null);
    const match = sizeOptions(p).find(option=>{
      const value = compact(option.value);
      const explicit = /^(us|uk|eu)|(?:us|uk|eu)$/.exec(value)?.[0];
      if (explicit && chosen && explicit.toUpperCase() !== chosen || !explicit && chosen && chosen !== "US") return false;
      const label = value.replace(/^(?:us|uk|eu)|(?:us|uk|eu)$/g,"");
      return label === target || (/^\d+(?:\.\d+)?$/.test(target) && new RegExp("^"+target.replace(".","\\.")+"(?:wide|[abdw]{1,2})$").test(label));
    });
    if (match) return {kind:"option",label:match.value,price:match.price,selected:match.selected,assumed:chosen === "US" && !/\bUS\b/i.test(match.value),system:chosen};
    if (chosen && p.sizeChart[chosen]?.includes(size)) return {kind:"chart",label:size,system:chosen};
    return {kind:"missing",system:chosen};
  }
  function compatibility(p,target) {
    if (!target) return {status:"unconfirmed",evidence:null};
    const compact = x=>word(x).replace(/[^a-z0-9]+/g," ").trim();
    const normalized = compact(target);
    if (!normalized) return {status:"unconfirmed",evidence:null};
    const modelSuffix = /\b(?:iphone|ipad|galaxy|pixel|macbook)\b/.test(normalized)
      ? "(?!\\s+(?:pro|max|plus|mini|air|ultra))" : "";
    const targetPattern = new RegExp("\\b"+normalized+"\\b"+modelSuffix,"i");
    const matches = p.compatibility.filter(x=>targetPattern.test(compact(x)));
    const negative = matches.find(x=>/\b(?:not compatib|incompatib|does not|do not|not for|except|excludes?)\w*/i.test(x));
    if (negative) return {status:"incompatible",evidence:negative};
    const positive = matches.find(x=>/\b(?:compatib|support|designed for|fits|works with)\w*/i.test(x) && !/\b(?:may|might|not|without|except)\b/i.test(x));
    return {status:positive ? "supported" : "unconfirmed",evidence:positive || null};
  }
  function index(products) {
    const docs = [], df = new Map(), byId = new Map();
    for (const product of products) {
      const words = tokens([product.name,product.name,product.name,product.trail,product.query,product.brand,
        product.description.slice(0,440),...product.material.map(([,value])=>value)].join(" "));
      const tf = new Map();
      for (const t of words) tf.set(t,(tf.get(t) || 0)+1);
      for (const t of tf.keys()) df.set(t,(df.get(t) || 0)+1);
      docs.push({product,tf,length:words.length});
      byId.set(product.id,product);
    }
    return {docs,df,byId,avg:docs.reduce((n,d)=>n+d.length,0)/Math.max(1,docs.length)};
  }
  function filterEvidence(product) {
    return [
      [product.name,"商品名称"], [product.brand,"品牌"], [product.trail,"目录分类"],
      ...product.material.map(([,value])=>[value,"材质字段"]),
      ...Object.values(product.specs).map(value=>[value,"规格字段"]),
      ...product.description.split(/(?<=[.!?])\s+|[\r\n]+/).map(text=>[text,"商品说明"])
    ].filter(([value])=>value).map(([value,field])=>({text:" "+tokens(value).join(" ")+" ",field,excerpt:value}));
  }
  function rank(idx,plan,modelOnly = false) {
    const terms = unique(tokens(plan.terms.join(" ")).filter(x=>!stop.has(x)));
    const exact = plan.terms.find(x=>/^[a-z0-9]{10}$/i.test(x) && idx.byId.has(x.toUpperCase()));
    const max = plan.max_price === null ? null : Math.round(plan.max_price*100);
    const min = plan.min_price === null ? null : Math.round(plan.min_price*100);
    const required = (plan.required_terms ?? []).map(value=>[value," "+tokens(value).join(" ")+" "]);
    const excluded = (plan.excluded_terms ?? []).map(value=>" "+tokens(value).join(" ")+" ");
    const phoneCase = !modelOnly && terms.includes("case") && (terms.includes("phone") || /\b(?:iphone|galaxy|pixel)\b/i.test(plan.compatibility_target || ""));
    const hits = [];
    for (const doc of idx.docs) {
      const p = doc.product;
      if (exact && p.id !== exact.toUpperCase()) continue;
      if (plan.category && p.category !== plan.category || plan.shoe && !p.shoe || plan.audience && p.audience !== plan.audience) continue;
      let matchedTerms = [];
      if (required.length || excluded.length) {
        const evidence = filterEvidence(p);
        if (excluded.some(term=>evidence.some(item=>item.text.includes(term)))) continue;
        matchedTerms = required.map(([term,phrase])=>[term,evidence.find(item=>item.text.includes(phrase))]);
        if (matchedTerms.some(([,source])=>!source)) continue;
      }
      if (phoneCase && !/\b(?:cases?|protective cover)\b/i.test(p.name+" "+p.trail)) continue;
      if (plan.color && !colorOptions(p).some(v=>tokens(v.value).includes(plan.color))) continue;
      const size = sizeEvidence(p,plan.size,plan.size_system);
      if (plan.size && size.kind === "missing") continue;
      const priceBasis = size.kind === "option" && size.price !== null ? size.price : p.price;
      if (max !== null && (priceBasis === null || priceBasis > max || plan.price_exclusive && priceBasis === max) ||
          min !== null && (priceBasis === null || priceBasis < min)) continue;
      const fit = plan.compatibility_target ? compatibility(p,plan.compatibility_target) : null;
      if (fit?.status === "incompatible") continue;
      if (modelOnly && fit?.status === "unconfirmed") continue;
      if (phoneCase && fit?.status === "unconfirmed" && /\b(?:iphone|galaxy|pixel|motorola|moto)\b[^\n]{0,25}\b\d{1,4}\b/i.test(p.name) &&
          !word(p.name).includes(word(plan.compatibility_target))) continue;
      let score = 0;
      for (const t of terms) {
        const tf = doc.tf.get(t) || 0;
        const df = idx.df.get(t) || 0;
        if (tf) score += Math.log(1+(idx.docs.length-df+.5)/(df+.5))*(tf*2.2)/(tf+1.2*(.25+.75*doc.length/Math.max(1,idx.avg)));
      }
      if (!exact && terms.length && !score && fit?.status !== "supported" && !matchedTerms.length) continue;
      if (plan.size && size.kind === "option") score += 8;
      if (fit?.status === "supported") score += 30;
      if (p.images.length && plan.tasks.includes("image")) score += .15;
      if (!modelOnly && !terms.length && plan.category === "beauty" && plan.tasks.includes("recommend")) {
        if (/\b(?:needles?|piercing|tattoo)\b/i.test(p.name)) score -= 2;
        if (p.brand && p.specs["Item Form"]) score += .5;
      }
      hits.push({p,score,size,priceBasis,matchedTerms});
    }
    hits.sort((a,b)=>(plan.sort === "price_asc" ? (a.priceBasis ?? Infinity)-(b.priceBasis ?? Infinity) :
      plan.sort === "price_desc" ? (b.priceBasis ?? -1)-(a.priceBasis ?? -1) : b.score-a.score) ||
      (a.priceBasis ?? Infinity)-(b.priceBasis ?? Infinity) || a.p.id.localeCompare(b.p.id));
    if (plan.budget_scope !== "total" || max === null) {
      if (!modelOnly && plan.sort === "relevance" && plan.category && !terms.length && !plan.shoe && plan.tasks.includes("recommend")) {
        const seen = new Set(), head = [], tail = [];
        for (const hit of hits) {
          const aisle = hit.p.query || hit.p.trail;
          if (!seen.has(aisle) && hit.score >= 0) { seen.add(aisle); head.push(hit); }
          else tail.push(hit);
        }
        return {hits:[...head,...tail].slice(0,plan.limit),total:hits.length};
      }
      return {hits:hits.slice(0,plan.limit),total:hits.length};
    }
    let sum = 0;
    const basket = [];
    for (const hit of hits) {
      if (basket.length >= plan.limit) break;
      if (sum+hit.priceBasis > max || plan.price_exclusive && sum+hit.priceBasis === max) continue;
      basket.push(hit);
      sum += hit.priceBasis;
    }
    return {hits:basket,total:hits.length,totalPrice:sum};
  }
  function card(p,position,plan,size = sizeEvidence(p,plan.size,plan.size_system),matchedTerms = []) {
    const sizeList = sizeOptions(p), colorList = colorOptions(p), facts = [], gaps = [];
    const has = key=>plan.tasks.includes(key);
    const detailed = plan.action !== "search";
    for (const [term,source] of matchedTerms) facts.push(["筛选依据",term,source.field]);
    if (has("color") || detailed || plan.color || (has("specs") && colorList.length)) {
      if (colorList.length) facts.push(["颜色选项",colorList.map(x=>x.value).join("、"),"customization_options / product_information"]);
      else gaps.push("目录未记录颜色选项。");
    }
    if (has("size") || detailed || plan.size || (has("specs") && sizeList.length)) {
      if (sizeList.length) facts.push(["尺码选项",sizeList.map(x=>x.value).join("、"),"customization_options"]);
      else gaps.push("目录未记录可选尺码。");
      if (Object.values(p.sizeChart).some(x=>x.length)) facts.push(["尺码表",Object.entries(p.sizeChart).filter(([,v])=>v.length).map(([k,v])=>k+" "+v.join("、")).join("；"),"full_description"]);
    }
    if (plan.size) {
      if (size.kind === "option") {
        facts.push(["目标尺码",size.label+(size.assumed ? "（按美国目录推定 US 码）":""),"customization_options"]);
        if (size.price !== null) facts.push(["目标尺码历史标价",money(size.price),"customization_options.price_string"]);
        else gaps.push("目标尺码缺少独立历史标价，预算按商品快照价核对，请确认该尺码实际售价。");
      } else if (size.kind === "chart") gaps.push("目标尺码 "+size.system+" "+size.label+" 只出现在尺码表中，可选状态与价格待核实。");
      else gaps.push("目录没有足够资料核实目标尺码。");
    }
    if (has("variant_price")) {
      const values = has("color") && !has("size") ? [["颜色",colorList]] : [["尺码",sizeList],...(has("color") ? [["颜色",colorList]] : [])];
      for (const [label,opts] of values) {
        if (opts.some(v=>v.price !== null)) facts.push([label+"历史标价",opts.map(v=>v.value+" "+money(v.price)).join("、"),"customization_options.price_string"]);
        else gaps.push("各"+label+"的独立标价未记录，商品快照价不能分摊到选项。");
      }
    }
    if (has("material") || detailed || has("recommend")) {
      if (p.material.length) facts.push(["材质",p.material.map(([k,v])=>k+" · "+v).join("；"),"product_information / 商品说明"]);
      else if (has("material") || detailed) gaps.push("目录缺少明确标注的材质资料。");
    }
    if (has("specs") || detailed || has("recommend")) {
      const entries = Object.entries(p.specs).filter(([key])=>!/^colou?r$|^size$/i.test(key));
      if (entries.length) facts.push(["规格",entries.slice(0,8).map(([k,v])=>k+" · "+v).join("；"),"product_information"]);
      else if (has("specs") || detailed) gaps.push("目录缺少结构化规格。");
    }
    if (has("inventory")) {
      if (p.quantity !== null) facts.push(["历史库存记录",String(p.quantity),"availability_quantity"]);
      else if (p.inventory) facts.push(["历史库存状态",p.inventory === "in_stock" ? "曾记录为有货" : "曾记录为缺货","availability_status"]);
      gaps.push("当前库存与颜色／尺码组合库存需要到当前商品页确认。");
    }
    if (has("compatibility") || plan.compatibility_target) {
      const fit = compatibility(p,plan.compatibility_target);
      if (fit.status === "supported") facts.push(["兼容线索",fit.evidence,"商品说明 / product_information"]);
      if (fit.status === "incompatible") facts.push(["不兼容线索",fit.evidence,"商品说明 / product_information"]);
      if (fit.status === "unconfirmed") gaps.push(plan.compatibility_target ?
        "目录缺少与 "+plan.compatibility_target+" 明确兼容的依据，请核对具体型号、接口或尺寸。" : "请提供具体设备型号或使用条件，以核对兼容性。");
    }
    if (has("image") && !p.images.length) gaps.push("目录未记录可展示的商品图。");
    let reason = null;
    if (has("recommend")) {
      const parts = [];
      for (const [term,source] of matchedTerms) parts.push(source.field+"记录了 "+term);
      if (plan.color) parts.push("目录有 "+plan.color+" 颜色选项");
      if (plan.size && size.kind === "option") parts.push("选项表记录了 "+size.label+" 码");
      if (p.material.length) parts.push("材质标注为 "+p.material.slice(0,2).map(([k,v])=>k+" "+v).join("、"));
      if (p.trail) parts.push("目录归类为 "+p.trail.split("›").slice(-1)[0].trim());
      const specs = Object.entries(p.specs).filter(([k])=>/item form|capacity|compatible|connector|weight|dimensions/i.test(k));
      if (specs.length) parts.push(specs[0].join(" · "));
      if (plan.max_price !== null && p.price !== null) parts.push("商品目录快照价为 "+money(p.price));
      else if (p.brand) parts.push("目录品牌为 "+p.brand);
      reason = parts.length ? parts.join("，")+"。" : "目录仅提供商品名称，可结合商品页面进一步核实。";
    }
    const matchedEvidence = matchedTerms.map(([term,source])=>({term,field:source.field,excerpt:String(source.excerpt).slice(0,250)}));
    return {id:p.id,position,name:p.name,category:p.category,trail:p.trail,brand:p.brand,price:p.price,listPrice:p.listPrice,matchedEvidence,
      images:has("image") || plan.action === "search" ? p.images : [],facts,gaps,reason,link:"https://www.amazon.com/dp/"+p.id};
  }
  function compare(cards) {
    const prices = cards.filter(c=>c.price !== null).sort((a,b)=>a.price-b.price);
    if (cards.length < 2) return "需要至少两款商品来比较。";
    if (prices.length !== cards.length) return "部分商品缺少目录价，无法完整比较价格。";
    if (prices[0].price === prices.at(-1).price) return "所选商品的目录快照价相同，均为 "+money(prices[0].price)+"。";
    if (prices.length === 2) return "第 "+prices[0].position+" 款的目录快照价更低（"+money(prices[0].price)+" 对 "+money(prices[1].price)+"），相差 "+money(prices[1].price-prices[0].price)+"。";
    return "第 "+prices[0].position+" 款快照价最低，最高与最低相差 "+money(prices.at(-1).price-prices[0].price)+"。";
  }
  function run(idx,question,state = {},remote = null) {
    const {plan:local,foreignCurrency} = localPlan(question,state);
    const plan = remote ? mergePlan(local,remote) : local;
    if (foreignCurrency) { plan.max_price = null; plan.min_price = null; }
    return execute(idx,question,state,plan,foreignCurrency);
  }
  function runModel(idx,question,state,remote) {
    return execute(idx,question,state,validatedPlan(remote),false,true);
  }
  function execute(idx,question,state,plan,foreignCurrency = false,modelOnly = false) {
    const retrievalStart = performance.now();
    const notes = [], oldIds = state.resultIds || [];
    let resultIds = oldIds, active = state.active || null, hits = [], total = 0, basketPrice;
    if (plan.action !== "search") {
      const positions = modelOnly || plan.refs.length ? plan.refs : plan.action === "compare" ? oldIds.slice(0,2).map((_,i)=>i+1) : active ? [active] : oldIds.length === 1 ? [1] : [];
      if (!positions.length) notes.push(oldIds.length ? "请指明要查看的商品序号，例如「第三款」。" : "请先检索商品生成清单，再按序号追问。");
      for (const position of positions) {
        const p = idx.byId.get(oldIds[position-1]);
        if (p) hits.push({p,position});
        else notes.push("上一份清单中没有第 "+position+" 款。");
      }
      if (hits.length === 1) active = hits[0].position;
      total = hits.length;
    } else if (plan.category || plan.shoe || plan.terms.length || plan.audience || plan.size || plan.color || plan.required_terms?.length ||
      plan.max_price !== null || plan.min_price !== null || plan.compatibility_target || plan.excluded_terms?.length ||
      !modelOnly && /目录|商品|catalog/i.test(question) && !plan.tasks.includes("inventory")) {
      const candidateLimit = modelOnly && plan.budget_scope !== "total" ? Math.max(8,plan.limit) : plan.limit;
      const ranked = rank(idx,{...plan,limit:candidateLimit},modelOnly);
      hits = ranked.hits.map((hit,i)=>({...hit,position:i+1}));
      total = ranked.total;
      basketPrice = ranked.totalPrice;
      if (hits.length) { resultIds = hits.map(hit=>hit.p.id); active = hits.length === 1 ? 1 : null; }
      if (!hits.length) notes.push("目录中没有找到满足已识别条件的商品。可以提供商品的英文名称、品牌或型号来缩小查找范围。");
    } else notes.push("请提供想查看的商品类别、名称、品牌或型号。");
    const retrievalMs = Math.round((performance.now()-retrievalStart)*1000)/1000;
    const cards = hits.map(hit=>card(hit.p,hit.position,plan,hit.size,hit.matchedTerms));
    const recalledPages = hits.map(({p,position,score},index)=>({
      asin:p.id,url:cards[index].link,rank:index+1,position,score:score ?? null
    }));
    if (foreignCurrency) notes.push("目录价格采用美元，外币预算缺少换算依据，本次没有按该金额筛选。");
    if (plan.tasks.includes("price_history")) notes.push(priceHistoryNote);
    if (plan.tasks.includes("current_price")) notes.push("实时售价需要在当前商品页核实。");
    if (plan.tasks.includes("inventory") && !cards.length) notes.push("本目录缺少实时库存来源。");
    if (!modelOnly && plan.action === "compare" && cards.length) {
      notes.unshift(compare(cards));
      if (cards.length >= 2) {
        const kinds = cards.map(c=>"第 "+c.position+" 款 · "+(c.trail.split("›").at(-1)?.trim() || c.brand));
        notes.push("目录分类："+kinds.join("，")+"。材质、规格和选项见对应卡片。");
      }
    }
    if (basketPrice !== undefined && cards.length) notes.push("这组候选的目录价格合计 "+money(basketPrice)+"，运费、税费与实时价格待核实。");
    const conditions = [labels[plan.category],plan.shoe && "鞋履",plan.audience && {women:"女士",men:"男士",kids:"儿童"}[plan.audience],
      plan.size && [plan.size_system,plan.size+" 码"].filter(Boolean).join(" "),plan.color,
      plan.min_price !== null && "≥ "+money(Math.round(plan.min_price*100)),
      plan.max_price !== null && (plan.budget_scope === "total" ? "总预算 " : "")+(plan.price_exclusive ? "< " : "≤ ")+money(Math.round(plan.max_price*100)),
      ...(plan.required_terms ?? []),...(plan.excluded_terms ?? []).map(term=>"排除 "+term),
      plan.compatibility_target].filter(Boolean);
    const summary = cards.length ? plan.action === "search" ? "找到 "+total+" 件目录候选"+(cards.length < total ? "，显示 "+cards.length+" 件":"")+"。" :
      "已核对清单中的 "+cards.length+" 件商品。" : "目前没有可展示的匹配商品。";
    if (cards.length && plan.tasks.includes("recommend") && !plan.tasks.includes("inventory")) notes.push("下单前请核对当前价格、库存及所选规格组合。");
    return {plan,summary,notes,cards,conditions,taskLabels:plan.tasks.map(t=>taskLabels[t]),matched:total,retrievalMs,recalledPages,
      state:{resultIds,active,lastQuestion:plan.action === "search" && cards.length ? question : state.lastQuestion || ""}};
  }
  function evidencePages(answer) {
    return answer?.cards?.map(({id,link,price,images,facts})=>({
      asin:id,url:link,fields:[...new Set([
        ...(price === null ? [] : ["目录快照价"]),
        ...(images.length ? ["商品图片"] : []),
        ...facts.map(([, ,field])=>field)
      ])]
    })) ?? [];
  }
  function shortFact(value, limit = 86) {
    const text = String(value ?? "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,"").replace(/\s+/g," ").trim().replace(/[。；]+$/,"");
    if (text.length <= limit) return text;
    const head = text.slice(0,limit);
    const splitAt = Math.max(head.lastIndexOf("、"),head.lastIndexOf("；"),head.lastIndexOf(","),head.lastIndexOf(" "));
    return (splitAt > limit * .6 ? head.slice(0,splitAt) : head) + "…";
  }
  function materialText(value) {
    const fields = {material:"材质",fabric:"面料","fabric type":"面料","upper material":"鞋面",
      "outer material":"外层","sole material":"鞋底","lining material":"内衬","inner material":"里料"};
    const names = {leather:"皮革","faux leather":"人造皮革",synthetic:"合成材料",fabric:"织物",textile:"纺织面料",
      polyester:"聚酯纤维",cotton:"棉",rubber:"橡胶",mesh:"网布",satin:"缎面",suede:"绒面革",
      pusole:"PU 鞋底","artificial pusole":"人造 PU 鞋底"};
    const entries = value.split("；").map(item=>{
      const [key,...parts] = item.split(" · ");
      const raw = parts.join(" · ");
      return [parts.length ? fields[key.toLowerCase()] || key : "材质",parts.length ? names[raw.toLowerCase()] || raw : names[key.toLowerCase()] || key];
    });
    return shortFact(entries.filter(([field,value])=>field !== "材质" ||
      !entries.some(([other,known])=>other !== "材质" && known === value)).map(([field,value])=>field + "为" + value).join("，"));
  }
  function describeProduct(card, plan, single, sharedSize) {
    const facts = new Map((card.facts ?? []).map(([label,value])=>[label,value]));
    const tasks = new Set(plan.tasks ?? []);
    const detail = plan.action === "detail";
    const visible = label=>shortFact(facts.get(label));
    const knownColors = {black:"黑色",white:"白色",red:"红色",pink:"粉色",blue:"蓝色",gray:"灰色",grey:"灰色",
      green:"绿色",brown:"棕色",purple:"紫色",yellow:"黄色",beige:"米色",silver:"银色",gold:"金色",navy:"藏蓝色"};
    const descriptions = [];
    if (tasks.has("material")) {
      const material = facts.get("材质");
      descriptions.push(material ? "目录标注" + materialText(material) : "目录没有明确标注材质");
    }
    if (plan.size && !sharedSize) {
      const requested = [plan.size_system,plan.size].filter(Boolean).join(" ") + " 码";
      const chartOnly = (card.gaps ?? []).some(gap=>gap.includes("只出现在尺码表中"));
      descriptions.push(facts.has("目标尺码") ? "可选尺码中有 " + visible("目标尺码") + (facts.has("目标尺码历史标价") ?
        "，该选项的历史标价为 " + visible("目标尺码历史标价") : "") : chartOnly ?
        requested + "只出现在尺码表中，购买选项待核实" : "目录资料还无法确认是否有 " + requested);
    } else if (sharedSize && facts.has("目标尺码历史标价")) {
      descriptions.push("该尺码的历史标价为 " + visible("目标尺码历史标价"));
    } else if (!plan.size && tasks.has("size")) {
      descriptions.push(facts.has("尺码选项") ? "记录的尺码包括 " + visible("尺码选项") : facts.has("尺码表") ?
        "尺码表记录了 " + visible("尺码表") + "，可选尺码待核实" : "目录未记录可选尺码");
    }
    if (tasks.has("color") || detail && !descriptions.length && facts.has("颜色选项")) {
      const colors = facts.get("颜色选项");
      descriptions.push(colors ? "目录列出的颜色有" + shortFact(colors.split("、").map(color=>knownColors[color.toLowerCase()] || color).join("、")) : "目录未记录颜色选项");
    }
    if (tasks.has("specs")) {
      const specs = facts.get("规格");
      const fields = {"item model number":"型号","product dimensions":"商品尺寸","package dimensions":"包装尺寸",
        "item weight":"商品重量",manufacturer:"制造商",capacity:"容量"};
      const values = specs?.split("；").map(entry=>{
        const [name,...rest] = entry.split(" · ");
        return rest.length ? (fields[shortFact(name).toLowerCase()] || shortFact(name)) + "为 " + rest.join(" · ") : entry;
      }).join("，");
      descriptions.push(values ? "目录记录的" + shortFact(values) : "目录缺少具体规格");
    }
    if (tasks.has("inventory")) {
      descriptions.push(facts.has("历史库存记录") ? "快照中的库存数量为 " + visible("历史库存记录") :
        facts.has("历史库存状态") ? visible("历史库存状态") : "目录未记录库存数量");
    }
    if (tasks.has("compatibility")) {
      const target = plan.compatibility_target || "该设备";
      descriptions.push(facts.has("不兼容线索") ? "商品说明中有不支持 " + target + " 的记录" : facts.has("兼容线索") ?
        "商品说明中有适配 " + target + " 的记录" : "目前的目录资料不足以确认是否适配 " + target);
    }
    if (tasks.has("variant_price")) {
      const values = ["尺码历史标价","颜色历史标价"].filter(key=>facts.has(key));
      descriptions.push(...(values.length ? values.map(key=>key + "包括 " + visible(key)) : ["目录未记录各选项单独的标价"]));
    }
    if (detail && (tasks.has("price") || tasks.has("price_history"))) {
      descriptions.push(card.price == null ? "目录快照没有标价" : "目录快照价为 " + money(card.price));
    }
    if (tasks.has("recommend") && (!descriptions.length || plan.required_terms?.length && plan.action === "search") && card.reason) {
      descriptions.push(shortFact(card.reason,125));
    }
    if (detail && !descriptions.length && card.brand) descriptions.push("目录标注的品牌是 " + card.brand);
    if (!descriptions.length && !detail) return "";
    const number = "第 " + card.position + " 款";
    const name = single ? "（" + shortFact(card.name,78) + "）" : "";
    return number + name + "，" + (descriptions.join("；") || "目录已记录商品名称，可在完整属性中查看已有资料") + "。";
  }
  function replyParagraphs(answer) {
    const {cards = [], notes = [], plan = {}, matched} = answer;
    if (!cards.length) return notes.length ? [...notes] : [answer.summary || "目前没有可以核实的商品。"];
    const count = cards.length;
    const sharedSize = count > 1 && plan.action === "search" && plan.size &&
      cards.every(card=>card.facts?.some(([label])=>label === "目标尺码"));
    const seen = new Set();
    const paragraphs = [];
    const add = value=>{
      if (value && !seen.has(value)) { seen.add(value); paragraphs.push(value); }
    };
    if (plan.action === "compare") add(notes[0] || compare(cards));
    else if (plan.action === "detail") {
      if (count > 1) add("我按上一轮的顺序核对了你提到的 " + count + " 款商品。下面是目录里能查到的信息。");
    } else {
      const shoeLabel = {women:"女士鞋",men:"男士鞋",kids:"童鞋"};
      const items = plan.shoe ? shoeLabel[plan.audience] || "鞋款" : (labels[plan.category] || "") + "商品";
      const price = cards.map(card=>card.price).filter(Number.isFinite);
      const range = price.length ? Math.min(...price) === Math.max(...price) ? money(price[0]) :
        money(Math.min(...price)) + " 到 " + money(Math.max(...price)) : "";
      let intro = matched > count ? "我在目录里找到 " + matched + " 款符合筛选条件的" + items + "，这里先列出 " + count + " 款。" :
        "我在目录里找到了 " + count + " 款符合筛选条件的" + items + "。";
      if (sharedSize) {
        intro += "这几款都记录了 " + plan.size + " 码选项。";
        if (plan.size_system === "US") intro += "未注明尺码体系的选项按美国目录的 US 码核对。";
      }
      if (range && price.length === count) intro += "这" + (count === 1 ? "款" : "几款") + "的目录快照价" +
        (range.includes(" 到 ") ? "在 " + range + " 之间。" : "为 " + range + "。");
      if (plan.tasks?.includes("recommend") && price.length === count && count > 1 && Math.min(...price) < Math.max(...price)) {
        const cheapest = cards.find(card=>card.price === Math.min(...price));
        intro += "如果你优先考虑价格，可以先看快照价最低的第 " + cheapest.position + " 款。";
      }
      add(intro);
    }
    for (const card of cards) add(describeProduct(card,plan,count === 1,sharedSize));
    if (plan.tasks?.includes("inventory")) add("这些是目录快照中的记录，当前库存需要另行确认。");
    if (plan.size && cards.some(card=>(card.gaps ?? []).some(gap=>gap.includes("缺少独立历史标价")))) {
      add("部分尺码选项没有单独标价，预算是按对应商品的快照价核对的。所选尺码的实际价格需要另行确认。");
    }
    for (const note of notes) {
      if (!note.startsWith("目录分类：")) add(note);
    }
    return paragraphs;
  }
  function questionRecord({id,question,reference,answer,modelOutput,generationMs,version,...meta}) {
    const citations = evidencePages(answer);
    return {
      schema_version:1, question_id:id, question,
      reference_answer:reference ?? null,
      reference_evidence_pages:reference ? evidencePages(reference) : null,
      recalled_pages:answer ? answer.recalledPages ??
        citations.map(({asin,url},i)=>({rank:i+1,position:answer.cards[i].position,asin,url,score:null})) : null,
      model_answer:answer ?? null, model_output:modelOutput ?? null,
      output_citations:answer ? citations : null, retrieval_ms:answer?.retrievalMs ?? null,
      generation_ms:generationMs ?? null, model_and_config_version:version ?? null, ...meta
    };
  }
  return {index,rank,run,runModel,execute,questionRecord,replyParagraphs,localPlan,makePlan,mergePlan,taskLabels,labels,money,sizeEvidence,compatibility,colorOptions,sizeOptions,priceHistoryNote,
    localConfigVersion:"webshop-local-v2"};
});
