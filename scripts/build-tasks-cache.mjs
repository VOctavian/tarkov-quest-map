// Snapshots the full tasks/hideout GraphQL response (same query the app runs at
// startup) into tasks-cache-ru.json / tasks-cache-en.json. The app fetches
// api.tarkov.dev live on every load; when that API is down (e.g. HTTP 503) and
// the visitor has no localStorage cache from a prior visit either (first-time
// visitor, cleared storage), it falls back to these bundled snapshot files so
// the site still works instead of showing a bare error.
// Re-run this after quest/hideout data changes meaningfully; it's fine if it
// drifts a bit between runs since it's only a last-resort fallback.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAPHQL_URL = "https://api.tarkov.dev/graphql";

function buildQuery(lang){
  return "query { tasks(lang: " + lang + ") { id name minPlayerLevel wikiLink kappaRequired lightkeeperRequired " +
    "trader { id name normalizedName imageLink } " +
    "map { name } " +
    "taskRequirements { task { id name } } " +
    "startRewards { items { item { id name iconLink image512pxLink wikiLink link } count } traderStanding { trader { id name imageLink } standing } } " +
    "finishRewards { items { item { id name iconLink image512pxLink wikiLink link } count } traderStanding { trader { id name imageLink } standing } } " +
    "objectives { type description optional maps { name } " +
      "... on TaskObjectiveItem { count foundInRaid item { id name iconLink image512pxLink wikiLink link normalizedName } } " +
      "... on TaskObjectiveShoot { count targetNames usingWeapon { id name iconLink image512pxLink wikiLink link } usingWeaponMods { id name iconLink image512pxLink wikiLink link } } " +
      "... on TaskObjectiveExtract { count exitStatus zoneNames } " +
      "... on TaskObjectiveUseItem { count useAny { id name iconLink image512pxLink wikiLink link } } " +
      "... on TaskObjectiveBuildItem { item { id name iconLink image512pxLink wikiLink link } containsAll { id name iconLink image512pxLink wikiLink link } } " +
      "... on TaskObjectiveQuestItem { count } " +
      "... on TaskObjectiveExperience { count } " +
    "} } maps(lang: " + lang + ") { name normalizedName wiki } " +
    "hideoutStations(lang: " + lang + ") { id name normalizedName imageLink " +
      "levels { level itemRequirements { count item { id name iconLink image512pxLink wikiLink link } } " +
        "stationLevelRequirements { level station { id name } } " +
        "traderRequirements { level trader { id name imageLink } } } " +
      "crafts { level duration taskUnlock { id name } " +
        "requiredItems { count item { id name iconLink image512pxLink wikiLink link } } " +
        "rewardItems { count item { id name iconLink image512pxLink wikiLink link } } } } }";
}

async function fetchLang(lang){
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: buildQuery(lang) })
  });
  if(!res.ok) throw new Error("HTTP " + res.status + " for lang=" + lang);
  const json = await res.json();
  if(json.errors) throw new Error(json.errors.map(function(e){ return e.message; }).join("; "));
  return json.data;
}

async function main(){
  for(const lang of ["ru", "en"]){
    console.log("Fetching tasks snapshot for lang=" + lang + " ...");
    const data = await fetchLang(lang);
    const outPath = path.join(__dirname, "..", "tasks-cache-" + lang + ".json");
    fs.writeFileSync(outPath, JSON.stringify({ savedAt: Date.now(), data: data }));
    console.log("Wrote " + outPath + " (" + data.tasks.length + " tasks, " + data.hideoutStations.length + " hideout stations)");
  }
}

main().catch(function(err){
  console.error(err);
  process.exit(1);
});
