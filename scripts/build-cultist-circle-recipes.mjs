// Builds cultist-circle-recipes.json by scraping the "Убежище/Круг Сектантов. Крафты"
// wiki page (the only public source for these recipes — tarkov.dev's hideoutStations
// crafts field is empty for this station) and matching each item name against
// tarkov.dev's item catalog to get a real assets.tarkov.dev icon/id/wikiLink, so the
// in-app popup can reuse the existing item-tooltip component instead of hotlinking
// wikia images (which have caused hotlink-protection issues before in this project).

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_JSON = path.join(__dirname, "..", "cultist-circle-recipes.json");

const WIKI_URL = "https://escapefromtarkov.fandom.com/ru/wiki/" +
  encodeURIComponent("Убежище/Круг_Сектантов._Крафты").replace(/%2F/g, "/");
const GRAPHQL_URL = "https://api.tarkov.dev/graphql";

// A few item names on the wiki page don't exactly match tarkov.dev's item names
// (edition variants without their own DB entry, or a shortened weapon name).
const ALIAS = {
  "AK-74": "Автомат Калашникова АК-74 5.45x39",
  "Защищенный контейнер \"Гамма\" (The Unheard Edition)": "Защищенный контейнер \"Гамма\"",
  "Защищенный контейнер \"Гамма\" (Edge of Darkness Edition)": "Защищенный контейнер \"Гамма\""
};

function decodeEntities(s){
  return s.replace(/&quot;/g, "\"").replace(/&#039;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function extractIcon(chunk){
  var m = chunk.match(/data-src="(https:[^"]+)"/) || chunk.match(/\ssrc="(https:[^"]+)"/);
  return m ? m[1] : null;
}

// Each item mention in a cell starts with `<span class="mw-default-size"...>`. Some
// have an explicit `<code>xN</code>` count; "и/или" (either/or) alternatives after the
// first one often omit it (count defaults to 1 in that case).
function parseItemsInCell(cellHtml){
  cellHtml = cellHtml.replace(/<center>[\s\S]*?<\/center>/, ""); // drop the station logo block
  var chunks = cellHtml.split(/<span class="mw-default-size"/).slice(1);
  var items = [];
  chunks.forEach(function(chunk){
    var codeMatch = chunk.match(/<code>\s*x(\d+)\s*<\/code>/);
    var count = codeMatch ? parseInt(codeMatch[1], 10) : 1;
    var nameMatch = chunk.match(/<a[^>]*title="([^"]+)"[^>]*>([^<]+)<\/a>/);
    if(!nameMatch) return;
    items.push({ icon: extractIcon(chunk), count: count, name: decodeEntities(nameMatch[2].trim()) });
  });
  return items;
}

function parseDuration(cellHtml){
  var parts = cellHtml.split(/<br\s*\/>/);
  var text = parts[parts.length - 1].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
  return text || null;
}

function parseRecipesFromHtml(html){
  var tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  var out = [];
  tables.forEach(function(t){
    var rows = t.match(/<tr[\s\S]*?<\/tr>/g) || [];
    rows.slice(1).forEach(function(r){
      var ths = r.match(/<th[\s\S]*?<\/th>/g) || [];
      if(ths.length !== 5) return; // header/malformed row, skip
      var inputs = parseItemsInCell(ths[0]);
      var duration = parseDuration(ths[2]);
      var outputCellHtml = ths[4];
      var outputs = parseItemsInCell(outputCellHtml);
      if(!inputs.length || !outputs.length) return;
      out.push({
        inputs: inputs,
        outputs: outputs,
        outputsAreAlternatives: /и\/или/.test(outputCellHtml),
        duration: duration
      });
    });
  });
  return out;
}

async function fetchAllItems(){
  var res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ items(lang: ru) { id name iconLink image512pxLink wikiLink link } }" })
  });
  var json = await res.json();
  if(!json.data || !json.data.items) throw new Error("Unexpected GraphQL response: " + JSON.stringify(json).slice(0, 300));
  return json.data.items;
}

function resolveItem(byName, name){
  var real = byName[name] || byName[ALIAS[name]];
  return real
    ? { id: real.id, name: name, iconLink: real.iconLink, image512pxLink: real.image512pxLink, wikiLink: real.wikiLink, link: real.link }
    : { id: null, name: name, iconLink: null, image512pxLink: null, wikiLink: null, link: null };
}

async function main(){
  console.log("fetching wiki page...");
  // Node's own fetch gets a 403 from fandom's Cloudflare bot protection here (likely
  // TLS/JA3 fingerprinting, since matching HTTP headers didn't help) — curl isn't
  // flagged, so shell out to it instead.
  var html = execFileSync("curl", [
    "-s", "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    WIKI_URL
  ], { maxBuffer: 1024 * 1024 * 20 }).toString("utf8");
  if(!html || html.length < 1000) throw new Error("Wiki page fetch via curl returned unexpectedly short content (" + (html ? html.length : 0) + " bytes)");

  console.log("parsing recipes...");
  var recipes = parseRecipesFromHtml(html);
  console.log("found " + recipes.length + " recipes");

  console.log("fetching tarkov.dev item catalog...");
  var allItems = await fetchAllItems();
  var byName = {};
  allItems.forEach(function(it){ byName[it.name] = it; });

  var unmatched = new Set();
  var resolved = recipes.map(function(r){
    return {
      inputs: r.inputs.map(function(i){
        var x = resolveItem(byName, i.name);
        if(!x.id) unmatched.add(i.name);
        x.count = i.count;
        return x;
      }),
      outputs: r.outputs.map(function(o){
        var x = resolveItem(byName, o.name);
        if(!x.id) unmatched.add(o.name);
        x.count = o.count;
        return x;
      }),
      outputsAreAlternatives: r.outputsAreAlternatives,
      duration: r.duration
    };
  });

  if(unmatched.size){
    console.log("WARNING: could not match " + unmatched.size + " item name(s) to tarkov.dev's catalog:");
    unmatched.forEach(function(n){ console.log("  - " + n); });
    console.log("Add an ALIAS entry in this script for each, then re-run.");
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(resolved));
  console.log("wrote " + OUT_JSON + " (" + resolved.length + " recipes, " + unmatched.size + " unmatched names)");
}

main().catch(function(e){
  console.error("FATAL", e);
  process.exit(1);
});
