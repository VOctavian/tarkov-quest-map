// Adds a tarkovHelpUrl field to every guides.json entry that has a matching quest on
// tarkov.help, independent of guide/ru status. Additive only — never touches existing
// text/images/ru fields, so it's safe to run repeatedly without affecting the
// gap-fill/enrichment data already stored by fetch-guides-tarkovhelp.mjs.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_JSON = path.join(__dirname, "..", "guides.json");

const GRAPHQL_URL = "https://api.tarkov.dev/graphql";
const HELP_API = "https://api.tarkov.help/api/ru";
const REQUEST_DELAY_MS = 250;

const TRADER_NAME_TO_SLUG = {
  "Прапор": "prapor",
  "Терапевт": "therapist",
  "Лыжник": "skier",
  "Миротворец": "peacemaker",
  "Механик": "mechanic",
  "Барахольщик": "ragman",
  "Егерь": "jaeger",
  "Скупщик": "fence",
  "Смотритель": "lightkeeper",
  "Реф": "ref",
  "Водитель БТР": "btr_driver"
};

function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

function normalize(name){
  return name.trim().toLowerCase()
    .replace(/\s*\[[^\]]*\]\s*$/g, "")
    .replace(/ё/g, "е")
    .replace(/[«»"'.,:;!?()\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchTasks(){
  var query = "query { tasks(lang: ru) { id name trader { name } } }";
  var res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query })
  });
  var json = await res.json();
  if(!json.data || !json.data.tasks) throw new Error("Unexpected GraphQL response: " + JSON.stringify(json).slice(0, 300));
  return json.data.tasks;
}

async function buildTraderNameMap(slug){
  var res = await fetch(HELP_API + "/quests/trader/" + slug);
  var json = await res.json();
  var list = json.data || [];
  var byName = {};
  list.forEach(function(q){ byName[normalize(q.name)] = q.seo_link; });
  return byName;
}

function loadJSON(file, fallback){
  try{ return JSON.parse(fs.readFileSync(file, "utf8")); }catch(e){ return fallback; }
}

async function main(){
  var tasks = await fetchTasks();
  var guides = loadJSON(OUT_JSON, {});

  console.log("building tarkov.help trader name maps...");
  var traderMaps = {};
  var slugs = Array.from(new Set(Object.values(TRADER_NAME_TO_SLUG)));
  for(var i = 0; i < slugs.length; i++){
    traderMaps[slugs[i]] = await buildTraderNameMap(slugs[i]);
    await sleep(REQUEST_DELAY_MS);
  }

  var matched = 0, noMatch = 0;
  tasks.forEach(function(t){
    var slug = TRADER_NAME_TO_SLUG[t.trader.name];
    var map = slug && traderMaps[slug];
    var seoLink = map && map[normalize(t.name)];
    if(!seoLink){ noMatch++; return; }
    if(!guides[t.id]) guides[t.id] = { status: "no-page" };
    guides[t.id].tarkovHelpUrl = "https://tarkov.help/ru/quest/" + seoLink;
    matched++;
  });

  fs.writeFileSync(OUT_JSON, JSON.stringify(guides));
  console.log("done: matched=" + matched + " noMatch=" + noMatch + " / " + tasks.length);
}

main().catch(function(e){
  console.error("FATAL", e);
  process.exit(1);
});
