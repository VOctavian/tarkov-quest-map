// Fills in RU guide gaps (quests where the fandom wiki has no usable "Выполнение"
// section) using tarkov.help's pre-rendered `guide` HTML field as a fallback source.
// Only touches guides.json entries whose ru.status !== "ok" — never overwrites a
// working fandom-wiki guide. Matches tasks to tarkov.help quests by normalized RU
// name within the same trader (tarkov.help exposes no BSG quest id).
// Resumable: entries already patched with source:"tarkovhelp" are skipped.

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

function decodeHtmlEntities(s){
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
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

function extractGuideFromHtml(html){
  if(!html) return null;

  var images = [];
  var imgRe = /<img\b[^>]*>/g;
  var m;
  while((m = imgRe.exec(html))){
    var tag = m[0];
    var url = (tag.match(/\ssrc="([^"]+)"/) || [])[1];
    if(!url || url.indexOf("/img/articles/") === -1) continue; // skip trader/item icons
    var alt = decodeHtmlEntities((tag.match(/alt="([^"]*)"/) || [])[1] || "");
    if(images.every(function(im){ return im.url !== url; })) images.push({ url: url, alt: alt });
  }

  var text = html
    .replace(/<div class="bb-item-wrapper[\s\S]*?<\/div>\s*<\/div>/g, function(block){
      var name = (block.match(/class="item-name"[^>]*>\s*([^<]+)/) || [])[1];
      return name ? decodeHtmlEntities(name.trim()) : "";
    })
    .replace(/<div class="bb-quest"[\s\S]*?<\/div>\s*<\/div>/g, function(block){
      var name = (block.match(/target="_parent"[^>]*>\s*([^<]+)/) || [])[1];
      return name ? decodeHtmlEntities(name.trim()) : "";
    })
    .replace(/<table[\s\S]*?<\/table>/g, "")
    .replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/g, "")
    .replace(/<li[^>]*>/g, "\n• ")
    .replace(/<\/(p|li|div|tr)>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map(function(s){ return decodeHtmlEntities(s).trim(); })
    .filter(function(s){ return s && s !== "•"; })
    .join("\n");

  if(!text && !images.length) return null;
  return { text: text, images: images };
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

  var gapTasks = tasks.filter(function(t){
    var g = guides[t.id];
    return !g || !g.ru || g.ru.status !== "ok";
  });
  console.log("gap tasks: " + gapTasks.length + " / " + tasks.length);

  var fixed = 0, noMatch = 0, noGuide = 0, errors = 0, skipped = 0;
  for(var j = 0; j < gapTasks.length; j++){
    var t = gapTasks[j];
    if(guides[t.id] && guides[t.id].ru && guides[t.id].ru.source === "tarkovhelp"){ skipped++; continue; }

    var slug = TRADER_NAME_TO_SLUG[t.trader.name];
    var map = slug && traderMaps[slug];
    var seoLink = map && map[normalize(t.name)];
    if(!seoLink){ noMatch++; continue; }

    try{
      var res = await fetch(HELP_API + "/quests/" + seoLink);
      var json = await res.json();
      var guideHtml = json.data && json.data.guide;
      var extracted = extractGuideFromHtml(guideHtml);
      if(extracted){
        if(!guides[t.id]) guides[t.id] = { status: "no-page" };
        guides[t.id].ru = { status: "ok", title: seoLink, text: extracted.text, images: extracted.images, source: "tarkovhelp" };
        fixed++;
        console.log("fixed: " + t.id + " (" + t.name + ") <- " + seoLink);
      } else {
        noGuide++;
      }
    }catch(e){
      errors++;
      console.error("error " + t.id + ": " + e.message);
    }

    if(j % 15 === 0) fs.writeFileSync(OUT_JSON, JSON.stringify(guides));
    await sleep(REQUEST_DELAY_MS);
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(guides));
  console.log("done: fixed=" + fixed + " noMatch=" + noMatch + " noGuide=" + noGuide + " errors=" + errors + " skipped=" + skipped);
}

main().catch(function(e){
  console.error("FATAL", e);
  process.exit(1);
});
