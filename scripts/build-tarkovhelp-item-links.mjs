// Builds an itemId -> tarkov.help item-page slug map for every item that appears in a
// quest objective (giveItem/findItem/plantItem). tarkov.help exposes no item search-by-name
// API, so this fetches the real RU name for every slug listed in tarkov.help's public
// sitemap (~3900 items) via their per-item API, then matches by exact normalized name.
// This is slower than a transliteration guess but never produces a broken link.
// Resumable: caches the slug->name lookups so re-runs (e.g. after quest items change) are fast.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_JSON = path.join(__dirname, "..", "tarkovhelp-item-links.json");
const CACHE_JSON = path.join(__dirname, "tmp", "tarkovhelp-item-name-cache.json");

const GRAPHQL_URL = "https://api.tarkov.dev/graphql";
const SITEMAP_URL = "https://tarkov.help/sitemaps/sitemap-ru.xml";
const HELP_API = "https://api.tarkov.help/api/ru";
const CONCURRENCY = 8;

function normalize(name){
  return name.trim().toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'.,:;!?()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function loadJSON(file, fallback){
  try{ return JSON.parse(fs.readFileSync(file, "utf8")); }catch(e){ return fallback; }
}

async function fetchQuestItems(){
  var query = "query { tasks(lang: ru) { objectives { ... on TaskObjectiveItem { item { id name } } } } }";
  var res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query })
  });
  var json = await res.json();
  var items = {};
  json.data.tasks.forEach(function(t){
    (t.objectives || []).forEach(function(o){
      if(o.item) items[o.item.id] = o.item;
    });
  });
  return Object.values(items);
}

async function fetchSitemapSlugs(){
  var res = await fetch(SITEMAP_URL);
  var xml = await res.text();
  var slugs = [];
  var re = /<loc>https:\/\/tarkov\.help\/ru\/item\/([^<]+)<\/loc>/g, m;
  while((m = re.exec(xml))) slugs.push(m[1]);
  return slugs;
}

async function fetchItemName(slug){
  var res = await fetch(HELP_API + "/item/" + slug);
  var json = await res.json();
  return json.data && json.data.name;
}

async function buildSlugNameCache(slugs, cache){
  var pending = slugs.filter(function(s){ return !(s in cache); });
  console.log("slugs to fetch: " + pending.length + " (cached: " + (slugs.length - pending.length) + ")");
  var idx = 0, done = 0;
  async function worker(){
    while(idx < pending.length){
      var slug = pending[idx++];
      try{
        var name = await fetchItemName(slug);
        cache[slug] = name || null;
      }catch(e){
        cache[slug] = null;
      }
      done++;
      if(done % 200 === 0){
        console.log("fetched " + done + " / " + pending.length);
        fs.writeFileSync(CACHE_JSON, JSON.stringify(cache));
      }
    }
  }
  var workers = [];
  for(var i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  fs.writeFileSync(CACHE_JSON, JSON.stringify(cache));
}

async function main(){
  console.log("fetching quest items...");
  var items = await fetchQuestItems();
  console.log("unique items: " + items.length);

  console.log("fetching tarkov.help sitemap...");
  var slugs = await fetchSitemapSlugs();
  console.log("item slugs in sitemap: " + slugs.length);

  var cache = loadJSON(CACHE_JSON, {});
  await buildSlugNameCache(slugs, cache);

  var nameToSlug = {};
  Object.keys(cache).forEach(function(slug){
    var name = cache[slug];
    if(name) nameToSlug[normalize(name)] = slug;
  });

  var out = {};
  var matched = 0, unmatched = [];
  items.forEach(function(item){
    var slug = nameToSlug[normalize(item.name)];
    if(slug){
      out[item.id] = slug;
      matched++;
    } else {
      unmatched.push(item.name);
    }
  });

  fs.writeFileSync(OUT_JSON, JSON.stringify(out));
  console.log("matched: " + matched + " / " + items.length);
  if(unmatched.length){
    console.log("unmatched (" + unmatched.length + "):");
    unmatched.forEach(function(u){ console.log("  " + u); });
  }
}

main().catch(function(e){
  console.error("FATAL", e);
  process.exit(1);
});
