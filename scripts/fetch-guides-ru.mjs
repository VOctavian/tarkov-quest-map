// Adds Russian guide text to guides.json by resolving each quest's Russian
// wiki title (via langlinks, same approach the app uses for the "Open on
// wiki" link) and parsing its "Выполнение" (Guide) section.
// Resumable: skips tasks that already have a `ru` entry in guides.json.
// Images are reused from the English scrape (screenshots aren't localized).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_JSON = path.join(__dirname, "..", "guides.json");
const PROGRESS_MD = path.join(__dirname, "..", "GUIDE_PROGRESS_RU.md");

const GRAPHQL_URL = "https://api.tarkov.dev/graphql";
const WIKI_API = "https://escapefromtarkov.fandom.com/api.php";
const RU_WIKI_API = "https://escapefromtarkov.fandom.com/ru/api.php";
const REQUEST_DELAY_MS = 200;
const SAVE_EVERY = 15;
const SECTION_RE = /^(guide|walkthrough|выполнение|прохождение)$/i;

function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

function decodeHtmlEntities(s){
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function wikiTitleFromLink(link){
  if(!link) return null;
  try{
    var u = new URL(link);
    return decodeURIComponent(u.pathname.replace(/^\/wiki\//, "")).replace(/_/g, " ");
  }catch(e){ return null; }
}

function chunkArray(arr, size){
  var out = [];
  for(var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchTasks(){
  var query = "query { tasks(lang: en) { id name wikiLink } }";
  var res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query })
  });
  var json = await res.json();
  if(!json.data || !json.data.tasks) throw new Error("Unexpected GraphQL response: " + JSON.stringify(json).slice(0, 300));
  return json.data.tasks;
}

async function resolveRuTitles(tasks){
  var titleToTaskIds = {};
  tasks.forEach(function(t){
    var title = wikiTitleFromLink(t.wikiLink);
    if(!title) return;
    (titleToTaskIds[title] = titleToTaskIds[title] || []).push(t.id);
  });
  var uniqueTitles = Object.keys(titleToTaskIds);
  var ruTitleByTaskId = {};
  var batches = chunkArray(uniqueTitles, 45);

  for(var i = 0; i < batches.length; i++){
    var batch = batches[i];
    var url = WIKI_API + "?action=query&redirects=1&titles=" +
      encodeURIComponent(batch.join("|")) +
      "&prop=langlinks&lllang=ru&lllimit=500&format=json";
    try{
      var res = await fetch(url);
      var json = await res.json();
      if(json && json.query && json.query.pages){
        var normMap = {};
        (json.query.normalized || []).forEach(function(n){ normMap[n.to] = n.from; });
        (json.query.redirects || []).forEach(function(rd){ normMap[rd.to] = normMap[rd.from] || rd.from; });
        Object.keys(json.query.pages).forEach(function(pid){
          var page = json.query.pages[pid];
          var originalTitle = normMap[page.title] || page.title;
          var ll = page.langlinks && page.langlinks[0];
          if(!ll || !ll["*"]) return;
          (titleToTaskIds[originalTitle] || []).forEach(function(id){ ruTitleByTaskId[id] = ll["*"]; });
        });
      }
    }catch(e){ /* batch failed, tasks left unresolved */ }
    await sleep(REQUEST_DELAY_MS);
  }
  return ruTitleByTaskId;
}

async function fetchRuGuideSection(title){
  var secRes = await fetch(RU_WIKI_API + "?action=parse&redirects=1&page=" + encodeURIComponent(title) + "&format=json&prop=sections");
  var secJson = await secRes.json();
  if(!secJson.parse) return { status: "no-page" };
  var sec = secJson.parse.sections.find(function(s){ return SECTION_RE.test(String(s.line).trim()); });
  if(!sec) return { status: "no-section" };

  await sleep(REQUEST_DELAY_MS);
  var htmlRes = await fetch(RU_WIKI_API + "?action=parse&redirects=1&page=" + encodeURIComponent(title) + "&format=json&prop=text&section=" + sec.index);
  var htmlJson = await htmlRes.json();
  if(!htmlJson.parse) return { status: "no-page" };
  return { status: "ok", html: htmlJson.parse.text["*"] };
}

function extractText(html){
  if(!html) return null;
  var noTables = html.replace(/<table[\s\S]*?<\/table>/g, "");
  var text = noTables
    .replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/g, "")
    .replace(/<li[^>]*>/g, "\n• ")
    .replace(/<\/(p|li|div|tr)>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map(function(s){ return decodeHtmlEntities(s).trim(); })
    .filter(function(s){ return s && s !== "•"; })
    .join("\n");
  return text || null;
}

function loadJSON(file, fallback){
  try{ return JSON.parse(fs.readFileSync(file, "utf8")); }catch(e){ return fallback; }
}

function writeProgress(stats){
  var lines = [];
  lines.push("# Прогресс парсинга гайдов по квестам (русская версия)");
  lines.push("");
  lines.push("Последнее обновление: " + new Date().toISOString());
  lines.push("");
  lines.push("| Метрика | Значение |");
  lines.push("|---|---|");
  lines.push("| Всего квестов | " + stats.total + " |");
  lines.push("| Обработано | " + stats.processed + " / " + stats.total + " |");
  lines.push("| С русским гайдом | " + stats.withGuide + " |");
  lines.push("| Нет русского названия статьи | " + stats.noRuTitle + " |");
  lines.push("| Без секции на рус. вики | " + stats.noSection + " |");
  lines.push("| Страница рус. вики не найдена | " + stats.noPage + " |");
  lines.push("| Ошибки запроса | " + stats.errors.length + " |");
  lines.push("");
  if(stats.errors.length){
    lines.push("## Ошибки");
    lines.push("");
    stats.errors.slice(-50).forEach(function(e){
      lines.push("- " + e.name + " (`" + e.id + "`): " + e.message);
    });
    lines.push("");
  }
  lines.push(stats.processed >= stats.total ? "**Готово.**" : "_Скрипт ещё выполняется или был прерван — повторный запуск продолжит с того же места._");
  fs.writeFileSync(PROGRESS_MD, lines.join("\n") + "\n");
}

async function main(){
  var tasks = await fetchTasks();
  var guides = loadJSON(OUT_JSON, {});

  var stats = { total: tasks.length, processed: 0, withGuide: 0, noRuTitle: 0, noSection: 0, noPage: 0, errors: [] };
  Object.keys(guides).forEach(function(id){
    if(guides[id] && guides[id].ru){
      stats.processed++;
      var s = guides[id].ru.status;
      if(s === "ok") stats.withGuide++;
      else if(s === "no-section") stats.noSection++;
      else if(s === "no-page") stats.noPage++;
      else if(s === "no-ru-title") stats.noRuTitle++;
    }
  });
  writeProgress(stats);

  console.log("resolving russian wiki titles...");
  var ruTitles = await resolveRuTitles(tasks);
  console.log("resolved " + Object.keys(ruTitles).length + "/" + tasks.length);

  var sinceSave = 0;
  for(var i = 0; i < tasks.length; i++){
    var t = tasks[i];
    if(guides[t.id] && guides[t.id].ru) continue; // already processed (resume)
    if(!guides[t.id]) guides[t.id] = { status: "no-page" };

    var ruTitle = ruTitles[t.id];
    if(!ruTitle){
      guides[t.id].ru = { status: "no-ru-title" };
      stats.noRuTitle++; stats.processed++;
    } else {
      try{
        var section = await fetchRuGuideSection(ruTitle);
        if(section.status === "ok"){
          var text = extractText(section.html);
          if(text){
            guides[t.id].ru = { status: "ok", title: ruTitle, text: text };
            stats.withGuide++;
          } else {
            guides[t.id].ru = { status: "no-section", title: ruTitle };
            stats.noSection++;
          }
        } else {
          guides[t.id].ru = { status: section.status, title: ruTitle };
          if(section.status === "no-section") stats.noSection++; else stats.noPage++;
        }
      }catch(e){
        stats.errors.push({ id: t.id, name: t.name, message: e.message });
        stats.processed++;
        writeProgress(stats);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }
      stats.processed++;
    }

    sinceSave++;
    if(sinceSave >= SAVE_EVERY){
      fs.writeFileSync(OUT_JSON, JSON.stringify(guides));
      writeProgress(stats);
      sinceSave = 0;
      console.log("progress: " + stats.processed + "/" + stats.total);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(guides));
  writeProgress(stats);
  console.log("done: " + stats.processed + "/" + stats.total + " (ru=" + stats.withGuide + ", noRuTitle=" + stats.noRuTitle + ", noSection=" + stats.noSection + ", noPage=" + stats.noPage + ", errors=" + stats.errors.length + ")");
}

main().catch(function(e){
  console.error("FATAL", e);
  process.exit(1);
});
