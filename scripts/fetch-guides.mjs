// Fetches the "Guide" section (walkthrough text + screenshots) for every EFT quest
// from the fandom wiki and bundles it into guides.json for the app to load at runtime.
// Resumable: re-running skips quests already recorded in guides.json.
// Progress is tracked in GUIDE_PROGRESS.md so a long run can be monitored/resumed.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_JSON = path.join(__dirname, "..", "guides.json");
const PROGRESS_MD = path.join(__dirname, "..", "GUIDE_PROGRESS.md");

const GRAPHQL_URL = "https://api.tarkov.dev/graphql";
const WIKI_API = "https://escapefromtarkov.fandom.com/api.php";
const REQUEST_DELAY_MS = 200;
const SAVE_EVERY = 15;

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
    return decodeURIComponent(u.pathname.replace(/^\/wiki\//, ""));
  }catch(e){ return null; }
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

async function fetchGuideSection(title){
  var secRes = await fetch(WIKI_API + "?action=parse&redirects=1&page=" + encodeURIComponent(title) + "&format=json&prop=sections");
  var secJson = await secRes.json();
  if(!secJson.parse) return { status: "no-page" };
  var sec = secJson.parse.sections.find(function(s){ return /^(guide|walkthrough)$/i.test(String(s.line).trim()); });
  if(!sec) return { status: "no-section" };

  await sleep(REQUEST_DELAY_MS);
  var htmlRes = await fetch(WIKI_API + "?action=parse&redirects=1&page=" + encodeURIComponent(title) + "&format=json&prop=text&section=" + sec.index);
  var htmlJson = await htmlRes.json();
  if(!htmlJson.parse) return { status: "no-page" };
  return { status: "ok", html: htmlJson.parse.text["*"] };
}

function extractGuide(html){
  if(!html) return null;

  // drop tables (item/reward lists — already shown in the app's quest card)
  var noTables = html.replace(/<table[\s\S]*?<\/table>/g, "");

  // images: only ones flagged data-relevant="1" by the wiki (actual guide screenshots,
  // not infobox/item icons), preferring the real data-src over the lazy-load placeholder
  var images = [];
  var imgRe = /<img\b[^>]*>/g;
  var m;
  while((m = imgRe.exec(html))){
    var tag = m[0];
    if(!/data-relevant="1"/.test(tag)) continue;
    var dataSrc = (tag.match(/data-src="([^"]+)"/) || [])[1];
    var src = (tag.match(/\ssrc="([^"]+)"/) || [])[1];
    var url = dataSrc || src;
    if(!url || url.indexOf("data:") === 0) continue;
    url = url.replace(/\/scale-to-width-down\/\d+/, "");
    var alt = decodeHtmlEntities((tag.match(/alt="([^"]*)"/) || [])[1] || "");
    if(images.every(function(im){ return im.url !== url; })) images.push({ url: url, alt: alt });
  }

  var text = noTables
    .replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/g, "")
    .replace(/<li[^>]*>/g, "\n• ")
    .replace(/<\/(p|li|div|tr)>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map(function(s){ return decodeHtmlEntities(s).trim(); })
    .filter(function(s){ return s && s !== "•"; })
    // an image's caption sometimes repeats as a separate text node right next to it
    .filter(function(s, i, arr){ return i === 0 || s !== arr[i - 1]; })
    .join("\n");

  if(!text && !images.length) return null;
  return { text: text, images: images };
}

function loadJSON(file, fallback){
  try{ return JSON.parse(fs.readFileSync(file, "utf8")); }catch(e){ return fallback; }
}

function writeProgress(stats){
  var lines = [];
  lines.push("# Прогресс парсинга гайдов по квестам");
  lines.push("");
  lines.push("Последнее обновление: " + new Date().toISOString());
  lines.push("");
  lines.push("| Метрика | Значение |");
  lines.push("|---|---|");
  lines.push("| Всего квестов | " + stats.total + " |");
  lines.push("| Обработано | " + stats.processed + " / " + stats.total + " |");
  lines.push("| С гайдом (текст/картинки) | " + stats.withGuide + " |");
  lines.push("| Без секции Guide на вики | " + stats.noSection + " |");
  lines.push("| Страница вики не найдена | " + stats.noPage + " |");
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

  var stats = { total: tasks.length, processed: 0, withGuide: 0, noSection: 0, noPage: 0, errors: [] };
  Object.keys(guides).forEach(function(id){
    stats.processed++;
    if(guides[id] && guides[id].status === "ok") stats.withGuide++;
    else if(guides[id] && guides[id].status === "no-section") stats.noSection++;
    else if(guides[id] && guides[id].status === "no-page") stats.noPage++;
  });
  writeProgress(stats);

  var sinceSave = 0;
  for(var i = 0; i < tasks.length; i++){
    var t = tasks[i];
    if(guides[t.id]) continue; // already processed (resume)

    var title = wikiTitleFromLink(t.wikiLink);
    if(!title){
      guides[t.id] = { status: "no-page" };
      stats.noPage++; stats.processed++;
    } else {
      try{
        var section = await fetchGuideSection(title);
        if(section.status === "ok"){
          var guide = extractGuide(section.html);
          if(guide){
            guides[t.id] = { status: "ok", title: title, text: guide.text, images: guide.images };
            stats.withGuide++;
          } else {
            guides[t.id] = { status: "no-section", title: title };
            stats.noSection++;
          }
        } else {
          guides[t.id] = { status: section.status, title: title };
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
  console.log("done: " + stats.processed + "/" + stats.total + " (guide=" + stats.withGuide + ", noSection=" + stats.noSection + ", noPage=" + stats.noPage + ", errors=" + stats.errors.length + ")");
}

main().catch(function(e){
  console.error("FATAL", e);
  process.exit(1);
});
