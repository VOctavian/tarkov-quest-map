// Re-fetches guide sections for tasks that previously came back "no-section"/"no-page"
// because their wiki title was actually a redirect (action=parse without redirects=1
// returns an empty page). Reuses the titles already resolved and stored in guides.json,
// so no need to re-run title resolution against the GraphQL/langlinks APIs.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_JSON = path.join(__dirname, "..", "guides.json");

const WIKI_API = "https://escapefromtarkov.fandom.com/api.php";
const RU_WIKI_API = "https://escapefromtarkov.fandom.com/ru/api.php";
const REQUEST_DELAY_MS = 200;
const EN_SECTION_RE = /^(guide|walkthrough)$/i;
const RU_SECTION_RE = /^(guide|walkthrough|выполнение|прохождение)$/i;

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

async function fetchSection(api, title, sectionRe){
  var secRes = await fetch(api + "?action=parse&redirects=1&page=" + encodeURIComponent(title) + "&format=json&prop=sections");
  var secJson = await secRes.json();
  if(!secJson.parse) return { status: "no-page" };
  var sec = secJson.parse.sections.find(function(s){ return sectionRe.test(String(s.line).trim()); });
  if(!sec) return { status: "no-section" };

  await sleep(REQUEST_DELAY_MS);
  var htmlRes = await fetch(api + "?action=parse&redirects=1&page=" + encodeURIComponent(title) + "&format=json&prop=text&section=" + sec.index);
  var htmlJson = await htmlRes.json();
  if(!htmlJson.parse) return { status: "no-page" };
  return { status: "ok", html: htmlJson.parse.text["*"] };
}

function extractGuide(html){
  if(!html) return null;
  var noTables = html.replace(/<table[\s\S]*?<\/table>/g, "");

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
    .join("\n");

  if(!text && !images.length) return null;
  return { text: text, images: images };
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

async function main(){
  var guides = JSON.parse(fs.readFileSync(OUT_JSON, "utf8"));
  var ids = Object.keys(guides);

  var enFixed = 0, enChecked = 0, ruFixed = 0, ruChecked = 0;

  for(var i = 0; i < ids.length; i++){
    var id = ids[i];
    var g = guides[id];
    if(!g) continue;

    if((g.status === "no-section" || g.status === "no-page") && g.title){
      enChecked++;
      try{
        var section = await fetchSection(WIKI_API, g.title, EN_SECTION_RE);
        if(section.status === "ok"){
          var guide = extractGuide(section.html);
          if(guide){
            guides[id] = Object.assign({}, g, { status: "ok", text: guide.text, images: guide.images });
            enFixed++;
            console.log("EN fixed: " + id + " (" + g.title + ")");
          }
        }
      }catch(e){ console.error("EN error " + id + ": " + e.message); }
      await sleep(REQUEST_DELAY_MS);
    }

    var ru = guides[id].ru;
    if(ru && (ru.status === "no-section" || ru.status === "no-page") && ru.title){
      ruChecked++;
      try{
        var ruSection = await fetchSection(RU_WIKI_API, ru.title, RU_SECTION_RE);
        if(ruSection.status === "ok"){
          var ruText = extractText(ruSection.html);
          if(ruText){
            guides[id].ru = { status: "ok", title: ru.title, text: ruText };
            ruFixed++;
            console.log("RU fixed: " + id + " (" + ru.title + ")");
          }
        }
      }catch(e){ console.error("RU error " + id + ": " + e.message); }
      await sleep(REQUEST_DELAY_MS);
    }

    if(i % 20 === 0){
      fs.writeFileSync(OUT_JSON, JSON.stringify(guides));
    }
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(guides));
  console.log("done: EN checked=" + enChecked + " fixed=" + enFixed + " | RU checked=" + ruChecked + " fixed=" + ruFixed);
}

main().catch(function(e){
  console.error("FATAL", e);
  process.exit(1);
});
