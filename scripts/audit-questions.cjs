"use strict";

const {createHash} = require("node:crypto");
const {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} = require("node:fs");
const {dirname,join,resolve} = require("node:path");
const {parseArgs} = require("node:util");
require("../web/catalog");
const rag = require("../web/rag");

const root = resolve(__dirname,"..");
const {products,meta} = globalThis.ShopCatalog;
const idx = rag.index(products);
const localVersion = {model:"local-rule-planner",config_version:rag.localConfigVersion,catalog_sha256:meta.sha256};
const splits = ["train","validation","test"];
const {values} = parseArgs({options:{
  run:{type:"string"}, split:{type:"string"}, output:{type:"string"}
}});
if (values.split && !splits.includes(values.split)) throw Error("Invalid dataset split.");
const chosen = values.split ? [values.split] : values.run ? ["test"] : splits;

const readRows = path=>readFileSync(path,"utf8").split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));
const digest = path=>createHash("sha256").update(readFileSync(path)).digest("hex");

function sessionState(context) {
  const resultIds = [];
  for (const item of context?.previousResults ?? []) resultIds[item.position-1] = item.id;
  return {resultIds,active:context?.active ?? null,lastQuestion:context?.lastQuestion ?? ""};
}

function evaluationRuns(split,dataPath) {
  if (!values.run) return [{mode:"local",version:localVersion}];
  const candidates = ["evaluation-"+split,split].map(name=>join(values.run,name));
  const folder = candidates.find(name=>existsSync(join(name,"evaluation-config.json")));
  if (!folder) throw Error("No evaluation-config.json for split "+split);
  const manifest = JSON.parse(readFileSync(join(folder,"evaluation-config.json"),"utf8"));
  if (manifest.split !== split || manifest.data_sha256 !== digest(dataPath)) {
    throw Error("Evaluation manifest does not match the local "+split+" dataset.");
  }
  const configPath = join(values.run,"adapter","webshop-config.json");
  const adapterPath = join(values.run,"adapter","adapter_model.safetensors");
  if (existsSync(adapterPath) && digest(adapterPath) !== manifest.adapter_sha256) {
    throw Error("Evaluation manifest does not match the supplied adapter.");
  }
  const configFileHash = existsSync(configPath) ? digest(configPath) : null;
  const modelConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath,"utf8")) : null;
  return ["base","adapter"].map(mode=>{
    const path = join(folder,mode+"-predictions.jsonl");
    const predictions = existsSync(path) ? new Map(readRows(path).map(row=>[row.id,row])) : new Map();
    const version = {
      model:manifest.model_id ?? modelConfig?.model_id ?? "inclusionAI/Ling-3.0-tiny",
      revision:manifest.model_revision, config_version:manifest.config_version ?? null,
      config_file_sha256:configFileHash, adapter_sha256:mode === "adapter" ? manifest.adapter_sha256 : null,
      catalog_sha256:meta.sha256
    };
    return {mode,predictions,version,limit:manifest.limit ?? null};
  });
}

const records = [];
for (const split of chosen) {
  const dataPath = join(root,"data","sft",split+".jsonl");
  const rows = readRows(dataPath);
  for (const {mode,predictions,version,limit} of evaluationRuns(split,dataPath)) {
    for (const row of limit ? rows.slice(0,limit) : rows) {
      const state = sessionState(row.context);
      const standard = rag.execute(idx,row.question,state,rag.makePlan(row.expected));
      const prediction = predictions?.get(row.id);
      if (prediction?.expected && JSON.stringify(rag.makePlan(prediction.expected)) !== JSON.stringify(rag.makePlan(row.expected))) {
        throw Error("Prediction reference differs from the dataset for "+row.id);
      }
      const completed = mode === "local" || Boolean(prediction);
      let answer = null;
      let issue = prediction?.parse_error ?? null;
      let answerMode = null;
      if (completed && prediction?.plan) {
        try {
          answer = rag.run(idx,row.question,state,prediction.plan);
          answerMode = "model-plan-replay";
        } catch (error) {
          issue = error.message;
        }
      }
      if (completed && !answer) {
        answer = rag.run(idx,row.question,state);
        answerMode = mode === "local" ? "local" : "local-fallback";
      }
      records.push(JSON.stringify(rag.questionRecord({
        id:row.id,question:row.question,reference:standard,answer,
        modelOutput:prediction?.raw ?? prediction?.plan, generationMs:prediction?.generation_ms,
        version, split, mode, status:completed ? "recorded" : "pending",
        answer_mode:answerMode,
        reference_kind:"dataset-plan-and-catalog-replay", expected_plan:row.expected,
        legacy_generation_and_parse_ms:prediction?.generation_ms == null && Number.isFinite(prediction?.elapsed_s) ?
          Math.round(prediction.elapsed_s*1000) : null,
        issue, resolution:answerMode === "local-fallback" ? "local-planner-fallback" : null
      })));
    }
  }
}

const output = resolve(values.output ?? join(root,"runs","audit",values.run ? "kaggle-questions.txt" : "local-questions.txt"));
mkdirSync(dirname(output),{recursive:true});
const temporary = output+"."+process.pid+".tmp";
writeFileSync(temporary,records.join("\n")+"\n","utf8");
renameSync(temporary,output);
console.log(records.length+" question records written to "+output);
