// Downloads every guide screenshot referenced in guides.json into guide-images/
// and rewrites guides.json to point at the local copies. This avoids relying on
// fandom's CDN, which 404s hotlinked requests coming from a foreign Referer.
// Resumable: skips images that already exist on disk.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_JSON = path.join(__dirname, "..", "guides.json");
const IMAGES_DIR = path.join(__dirname, "..", "guide-images");
const REQUEST_DELAY_MS = 150;
const SCALE_WIDTH = 700;

function scaledUrl(url){
  // request a smaller rendition from the wiki's thumbnailer instead of the
  // full-resolution original, to keep the repo size reasonable
  return url.replace("/revision/latest", "/revision/latest/scale-to-width-down/" + SCALE_WIDTH);
}

const EXT_BY_MIME = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif"
};

function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

function sanitize(name){
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function main(){
  var guides = JSON.parse(fs.readFileSync(OUT_JSON, "utf8"));
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  var ids = Object.keys(guides);
  var downloaded = 0, skipped = 0, failed = 0;

  for(var i = 0; i < ids.length; i++){
    var id = ids[i];
    var g = guides[id];
    if(!g || g.status !== "ok" || !g.images || !g.images.length) continue;

    for(var j = 0; j < g.images.length; j++){
      var im = g.images[j];
      if(!im.url || im.url.indexOf("guide-images/") === 0) { skipped++; continue; }

      var baseName = sanitize(id + "_" + j);
      var existing = fs.readdirSync(IMAGES_DIR).find(function(f){ return f.startsWith(baseName + "."); });
      if(existing){
        im.url = "guide-images/" + existing;
        skipped++;
        continue;
      }

      try{
        var res = await fetch(scaledUrl(im.url));
        if(!res.ok) throw new Error("HTTP " + res.status);
        var mime = (res.headers.get("content-type") || "").split(";")[0].trim();
        var ext = EXT_BY_MIME[mime] || "jpg";
        var fileName = baseName + "." + ext;
        var buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(path.join(IMAGES_DIR, fileName), buf);
        im.url = "guide-images/" + fileName;
        downloaded++;
        if(downloaded % 25 === 0) console.log("downloaded: " + downloaded);
      }catch(e){
        console.error("FAILED " + id + " #" + j + " " + im.url + ": " + e.message);
        failed++;
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(guides));
  console.log("done: downloaded=" + downloaded + " skipped=" + skipped + " failed=" + failed);
}

main().catch(function(e){
  console.error("FATAL", e);
  process.exit(1);
});
