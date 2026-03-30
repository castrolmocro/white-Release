const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs-extra");
const path = require("path");
const { execSync, exec } = require("child_process");

const JIKAN = "https://api.jikan.moe/v4";
const TMP_DIR = path.join(process.cwd(), "scripts/cmds/tmp");
const MAX_MB = 700;
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Accept-Language": "ar,en;q=0.9" };

fs.ensureDirSync(TMP_DIR);

// ─── Jikan API (MyAnimeList) ──────────────────────────────────────────────────

async function searchAnime(query) {
  const res = await axios.get(`${JIKAN}/anime`, {
    params: { q: query, limit: 5, sfw: true, type: "tv" },
    timeout: 12000
  });
  return res.data.data || [];
}

async function getAnimeFull(malId) {
  const res = await axios.get(`${JIKAN}/anime/${malId}/full`, { timeout: 12000 });
  return res.data.data;
}

function getTitle(m) {
  return (m.title_english || m.title || m.title_japanese || "Unknown").trim();
}

function getStatus(s) {
  if (!s) return "";
  if (s.includes("Finished") || s === "FINISHED") return "منتهى ✅";
  if (s.includes("Airing") || s.includes("Currently") || s === "RELEASING") return "يُعرض الآن 🟢";
  if (s.includes("Not yet") || s === "NOT_YET_RELEASED") return "قريباً 🔜";
  if (s === "CANCELLED") return "ملغى ❌";
  return s;
}

function getSeason(s) {
  return { winter: "شتاء ❄️", spring: "ربيع 🌸", summer: "صيف ☀️", fall: "خريف 🍂", WINTER: "شتاء ❄️", SPRING: "ربيع 🌸", SUMMER: "صيف ☀️", FALL: "خريف 🍂" }[s] || (s || "");
}

function buildSeasons(media) {
  const seen = new Set();
  const list = [];

  const add = (entry) => {
    if (seen.has(entry.mal_id || entry.id)) return;
    seen.add(entry.mal_id || entry.id);
    list.push({
      id: entry.mal_id || entry.id,
      title: entry.title_english || entry.title || entry.name || getTitle(entry),
      episodes: entry.episodes || 0,
      season: entry.season,
      seasonYear: entry.year || entry.seasonYear,
      status: entry.status,
      format: entry.type || entry.format
    });
  };

  add(media);

  for (const rel of (media.relations || [])) {
    if (rel.relation === "Sequel" || rel.relation === "Prequel") {
      for (const e of (rel.entry || [])) {
        if (e.type === "anime") add(e);
      }
    }
  }

  list.sort((a, b) => (a.seasonYear || 9999) - (b.seasonYear || 9999));
  list.forEach((s, i) => { s.label = `الموسم ${i + 1}`; });
  return list;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function titleToSlug(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[:\u2019\u2018'`]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function getSlugsFromAnime(anime) {
  const slugs = new Set();
  const candidates = [
    anime.title_english,
    anime.title,
    anime.title_japanese
  ].filter(Boolean);
  for (const t of candidates) {
    const s = titleToSlug(t);
    if (s) slugs.add(s);
  }
  return [...slugs];
}

// ─── Downloader ───────────────────────────────────────────────────────────────

function downloadWithFFmpeg(videoUrl, referer, outFile) {
  return new Promise((resolve, reject) => {
    const ref = referer || "https://animelek.vip/";
    const cmd = `ffmpeg -y -headers "Referer: ${ref}" -i "${videoUrl}" -c:v copy -c:a aac "${outFile}" 2>&1`;
    exec(cmd, { timeout: 720000 }, (err) => {
      if (err) return reject(new Error(err.message));
      resolve(outFile);
    });
  });
}

function downloadWithFFmpegAndSub(videoUrl, subUrl, referer, outFile) {
  return new Promise((resolve, reject) => {
    const ref = referer || "https://hianime.to/";
    const cmd = `ffmpeg -y -headers "Referer: ${ref}" -i "${videoUrl}" -i "${subUrl}" -map 0:v -map 0:a -map 1:0 -c:v copy -c:a aac -c:s mov_text -metadata:s:s:0 language=ara "${outFile}" 2>&1`;
    exec(cmd, { timeout: 720000 }, (err) => {
      if (err) return reject(new Error(err.message));
      resolve(outFile);
    });
  });
}

async function downloadDirect(url, outFile, referer, onProgress) {
  const res = await axios.get(url, {
    responseType: "stream",
    headers: { ...UA, "Referer": referer || "https://animelek.vip/" },
    timeout: 720000,
    maxContentLength: MAX_MB * 1024 * 1024
  });
  const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
  let downloaded = 0;
  let lastPct = 0;

  if (onProgress && totalBytes > 0) {
    res.data.on("data", (chunk) => {
      downloaded += chunk.length;
      const pct = Math.floor((downloaded / totalBytes) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        onProgress({ pct, downloadedMB: downloaded / (1024 * 1024), totalMB: totalBytes / (1024 * 1024) });
      }
    });
  }

  const writer = fs.createWriteStream(outFile);
  res.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

function checkFile(outFile) {
  if (!fs.existsSync(outFile)) return null;
  const mb = fs.statSync(outFile).size / (1024 * 1024);
  return mb > 1 && mb <= MAX_MB ? mb : null;
}

// ─── Parallel HEAD scan ───────────────────────────────────────────────────────
// Checks all links simultaneously to find the best accessible one fast

// Dead or auth-required hosters — skip entirely to save time
const SKIP_HOSTERS = [
  "mega.nz", "drive.google.com", "4shared.com", "meganz", "mega.co.nz",
  "upbam.org", "upbaam.com",             // always 404
  "file-upload.com", "file-upload.org",  // always 404
  "solidfiles.com",                      // DNS failure on Railway
  "letsupload.io", "letsupload.co",      // returns HTML/invalid
  "twitter.com", "instagram.com",        // social links
  "youtube.com", "youtu.be",             // social links
  "myanimelist.net", "facebook.com",     // info sites
  "racaty.net"                           // returns HTML
];

// ─── Specialized hoster extractors ───────────────────────────────────────────

async function extractDoodstream(url, ref) {
  try {
    const id = url.match(/\/(?:d|e)\/([a-z0-9]+)/i)?.[1];
    if (!id) return null;
    const embedUrl = `https://doodstream.com/e/${id}`;
    console.log(`[anime] 🎬 doodstream embed: ${embedUrl}`);
    const r = await axios.get(embedUrl, { headers: { ...UA, Referer: ref }, timeout: 12000 });
    console.log(`[anime] 🔬 doodstream HTML[0:300]: ${r.data.slice(0, 300).replace(/\s+/g, " ")}`);
    const passPath = r.data.match(/\/pass_md5\/[^'"?\s]+/)?.[0];
    if (!passPath) { console.log(`[anime] ⚠️ doodstream: لم أجد pass_md5`); return null; }
    const passRes = await axios.get(`https://doodstream.com${passPath}`, {
      headers: { ...UA, Referer: embedUrl }, timeout: 10000
    });
    const base = passRes.data?.toString?.().trim();
    if (!base || !base.startsWith("http")) { console.log(`[anime] ⚠️ doodstream: invalid pass`); return null; }
    const token = passPath.split("/").pop();
    const rand = Math.random().toString(36).slice(2, 14);
    const final = `${base}${rand}?token=${token}&expiry=${Date.now()}`;
    console.log(`[anime] ✅ doodstream → ${final.slice(0, 80)}`);
    return { url: final, type: "direct" };
  } catch (e) { console.log(`[anime] ❌ doodstream: ${e.message?.slice(0, 50)}`); return null; }
}

async function extractVoe(url, ref) {
  try {
    console.log(`[anime] 🎬 voe.sx: ${url.slice(0, 60)}`);
    const r = await axios.get(url, { headers: { ...UA, Referer: ref }, timeout: 12000 });
    const hls = r.data.match(/'hls'\s*:\s*'(https?:\/\/[^']+)'/)?.[1]
             || r.data.match(/"hls"\s*:\s*"(https?:\/\/[^"]+)"/)?.[1]
             || r.data.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/)?.[0];
    if (hls) { console.log(`[anime] ✅ voe HLS → ${hls.slice(0, 80)}`); return { url: hls, type: "hls" }; }
    const mp4 = r.data.match(/'mp4'\s*:\s*'(https?:\/\/[^']+)'/)?.[1]
             || r.data.match(/"mp4"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/)?.[1];
    if (mp4) { console.log(`[anime] ✅ voe mp4 → ${mp4.slice(0, 80)}`); return { url: mp4, type: "direct" }; }
    console.log(`[anime] ⚠️ voe.sx: لم أجد stream`);
    return null;
  } catch (e) { console.log(`[anime] ❌ voe: ${e.message?.slice(0, 50)}`); return null; }
}

async function extractMp4upload(embedId, ref) {
  try {
    console.log(`[anime] 🎬 mp4upload embed: ${embedId}`);
    const r = await axios.get(`https://www.mp4upload.com/embed-${embedId}.html`, {
      headers: { ...UA, Referer: ref }, timeout: 15000
    });
    // Debug: show first 400 chars of response to understand page structure
    console.log(`[anime] 🔬 mp4upload HTML[0:400]: ${r.data.slice(0, 400).replace(/\s+/g, " ")}`);

    // Multiple patterns — try all known mp4upload formats
    const src = r.data.match(/"file"\s*:\s*"(https?:\/\/[^"]{10,})"/)?.[1]
             || r.data.match(/'file'\s*:\s*'(https?:\/\/[^']{10,})'/)?.[1]
             || r.data.match(/https?:\/\/storage\.mp4upload\.com[^\s"'<>\\]*/)?.[0]
             || r.data.match(/https?:\/\/[^"'\s<>]*mp4upload[^"'\s<>]*\.mp4[^"'\s<>]*/)?.[0]
             || r.data.match(/sources\s*:\s*\[\s*\{[^}]*(?:src|file)\s*:\s*["'](https?:\/\/[^"']{10,})["']/)?.[1]
             || r.data.match(/(?:src|file)\s*=\s*["'](https?:\/\/[^"']{10,}\.mp4[^"']*)/)?.[1];
    if (!src) {
      // Show all https URLs found in page for manual diagnosis
      const allUrls = (r.data.match(/https?:\/\/[^\s"'<>\\]{15,}/g) || []).slice(0, 5);
      console.log(`[anime] ⚠️ mp4upload: لم أجد رابط. URLs موجودة: ${allUrls.join(" | ")}`);
      return null;
    }
    console.log(`[anime] ✅ mp4upload src → ${src.slice(0, 80)}`);
    return { url: src, type: "direct" };
  } catch (e) { console.log(`[anime] ❌ mp4upload: ${e.message?.slice(0, 50)}`); return null; }
}

// ─── sortedLinks: classifies and ranks links ─────────────────────────────────
function sortedLinks(links) {
  return links
    .filter(({ url }) => url && url.startsWith("http") && !SKIP_HOSTERS.some(h => url.includes(h)))
    .map(({ url, q }) => {
      const b = q || 1;
      if (url.includes(".m3u8")) return { url, q: b + 100, type: "hls" };
      if (url.includes("doodstream.com")) return { url, q: b + 10, type: "doodstream" };
      const mpId = url.includes("mp4upload.com")
        ? (url.match(/embed-([a-z0-9]+)\.html/)?.[1] || url.match(/mp4upload\.com\/([a-z0-9]+)/)?.[1])
        : null;
      if (mpId) return { url, q: b + 8, type: "mp4upload", embedId: mpId };
      if (url.includes("voe.sx")) return { url, q: b + 6, type: "voe" };
      const isDirectVideo = /\.(mp4|mkv|avi|webm)(\?|$)/i.test(url);
      return { url, q: isDirectVideo ? b + 3 : b, type: "direct" };
    })
    .sort((a, b) => b.q - a.q);
}

// ─── downloadBestLink: iterates candidates, tries specialized extractors ─────
async function downloadBestLink(links, outFile, referer, onProgress) {
  const ref = referer || "https://animelek.vip/";
  const candidates = sortedLinks(links);

  console.log(`[anime] 🔗 ${candidates.length} رابط مرشح للتحميل:`);
  for (const c of candidates) console.log(`  [${c.type}] q=${c.q} → ${c.url.slice(0, 80)}`);

  for (const best of candidates) {
    try {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      let resolvedUrl = best.url;
      let resolvedType = best.type;

      // ── Specialized extractors ────────────────────────────────────────────
      if (best.type === "doodstream") {
        const res = await extractDoodstream(best.url, ref);
        if (!res) continue;
        resolvedUrl = res.url; resolvedType = res.type;
      } else if (best.type === "mp4upload") {
        const res = await extractMp4upload(best.embedId, ref);
        if (!res) continue;
        resolvedUrl = res.url; resolvedType = res.type;
      } else if (best.type === "voe") {
        const res = await extractVoe(best.url, ref);
        if (!res) continue;
        resolvedUrl = res.url; resolvedType = res.type;
      }

      // ── Download resolved URL ─────────────────────────────────────────────
      if (resolvedType === "hls") {
        console.log(`[anime] ⬇️ HLS ffmpeg: ${resolvedUrl.slice(0, 80)}`);
        await downloadWithFFmpeg(resolvedUrl, ref, outFile);
      } else {
        // HEAD check to skip obvious HTML responses
        let skip = false;
        try {
          const head = await axios.head(resolvedUrl, {
            headers: { ...UA, Referer: ref }, timeout: 10000, maxRedirects: 6
          });
          const ct = (head.headers["content-type"] || "").toLowerCase();
          const cl = parseInt(head.headers["content-length"] || "0", 10);
          console.log(`[anime] ↩️ HEAD ct=${ct.split(";")[0]} cl=${(cl/1024/1024).toFixed(1)}MB`);
          if (ct.includes("text/html") && !resolvedUrl.match(/\.(mp4|mkv|avi)(\?|$)/i)) {
            console.log(`[anime] ⛔ HTML response, جرب رابط آخر`);
            skip = true;
          }
        } catch (e) {
          console.log(`[anime] ⚠️ HEAD فشل (${e.message?.slice(0, 40)}), أحاول التحميل المباشر...`);
        }
        if (skip) continue;
        console.log(`[anime] ⬇️ direct: ${resolvedUrl.slice(0, 80)}`);
        await downloadDirect(resolvedUrl, outFile, ref, onProgress);
      }

      const mb = checkFile(outFile);
      if (mb) { console.log(`[anime] ✅ تحميل ناجح ${mb.toFixed(1)} MB`); return mb; }
      console.log(`[anime] ⛔ الملف غير صالح`);
    } catch (e) {
      console.log(`[anime] ❌ فشل: ${e.message?.slice(0, 60)}`);
      continue;
    }
  }
  return null;
}

// ─── Extract embedded streams from HTML ──────────────────────────────────────
// Finds direct m3u8/mp4 URLs baked into the page JS (jwplayer, plyr, html5 video)
// These bypass external file hosters entirely

function extractStreams(html) {
  const streams = [];
  const seen = new Set();

  const add = (url, q) => {
    if (!url || seen.has(url)) return;
    if (!url.startsWith("http")) return;
    seen.add(url);
    streams.push({ url, q, type: url.includes(".m3u8") ? "hls" : "direct" });
  };

  // <source src="..."> or <video src="...">
  for (const m of html.matchAll(/(?:src|data-src)\s*=\s*["']([^"']+\.(?:mp4|m3u8|mkv)[^"']*)/gi))
    add(m[1], 50);

  // jwplayer / plyr / videojs: "file":"URL" or file: "URL"
  for (const m of html.matchAll(/"file"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/gi))
    add(m[1], 60);

  // sources: [{src:"URL"}]
  for (const m of html.matchAll(/["']src["']\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)/gi))
    add(m[1], 55);

  // Any bare https URL ending in .mp4 or .m3u8 in the HTML
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8)(?:[?#][^\s"'<>\\]*)?/gi))
    add(m[0], 40);

  return streams.sort((a, b) => b.q - a.q);
}

// ─── Resolve iframe embeds ─────────────────────────────────────────────────────
// Some pages embed the player in an iframe; fetch the iframe and re-extract

async function resolveIframeStreams(html, referer) {
  const streams = [];
  const iframes = [];

  for (const m of html.matchAll(/(?:src|data-src)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    const u = m[1];
    if (u.includes("animelek") || u.includes("shahiid")) continue; // same site, ignore nav iframes
    if (u.includes("embed") || u.includes("player") || u.includes("stream") ||
        u.includes("vod") || u.includes("video") || u.includes("play")) {
      iframes.push(u);
    }
  }

  console.log(`[anime] 🖼️ ${iframes.length} iframe(s) للفحص`);

  for (const src of iframes.slice(0, 3)) {
    try {
      console.log(`[anime] 🌐 iframe GET ${src.slice(0, 80)}`);
      const r = await axios.get(src, {
        headers: { ...UA, Referer: referer }, timeout: 12000
      });
      const found = extractStreams(r.data);
      console.log(`[anime] ↩️ iframe → ${found.length} stream(s)`);
      streams.push(...found);
    } catch (_) {}
  }
  return streams;
}

// ─── Source 1: animelek.vip (Primary – confirmed working) ────────────────────
// Episode URL pattern: /episode/{slug}-{N}-الحلقة/

async function tryAnimelek(slugs, epNum, outFile, onProgress) {
  const epAr = "%D8%A7%D9%84%D8%AD%D9%84%D9%82%D8%A9";
  const ref = "https://animelek.vip/";

  console.log(`[anime] 🔎 tryAnimelek ep=${epNum} slugs=[${slugs.join(", ")}]`);

  for (const slug of slugs) {
    const epUrl = `https://animelek.vip/episode/${slug}-${epNum}-${epAr}/`;
    try {
      console.log(`[anime] 🌐 GET ${epUrl}`);
      const r = await axios.get(epUrl, { headers: UA, timeout: 15000 });
      console.log(`[anime] ↩️ HTTP ${r.status}`);
      if (r.status !== 200) continue;

      const $ = cheerio.load(r.data);
      const allLinks = [];

      // ── Priority 1: embedded streams in page HTML (bypass file hosters) ──
      const pageStreams = extractStreams(r.data);
      console.log(`[anime] 🎬 ${pageStreams.length} stream(s) مدمج في الصفحة`);
      allLinks.push(...pageStreams);

      // ── Priority 2: iframe embeds ─────────────────────────────────────────
      const iframeStreams = await resolveIframeStreams(r.data, ref);
      allLinks.push(...iframeStreams);

      // ── Priority 3: external download links (file hosters) ───────────────
      $("a[href]").each((_, el) => {
        const h = $(el).attr("href") || "";
        const t = $(el).text().toLowerCase();
        if (!h.startsWith("http") || h.includes("animelek")) return;
        const q = t.match(/fhd|1080/) ? 4 : t.match(/hd|720/) ? 3 : t.match(/sd|480/) ? 2 : 1;
        allLinks.push({ url: h, q });
      });

      console.log(`[anime] 📄 animelek slug=${slug} ep=${epNum} → ${allLinks.length} رابط إجمالي`);
      if (!allLinks.length) continue;
      const mb = await downloadBestLink(allLinks, outFile, ref, onProgress);
      if (mb) return { filePath: outFile, sizeMB: mb, source: "AnimeLeK 🎌 (مترجم عربي)" };
    } catch (e) {
      console.log(`[anime] ⛔ tryAnimelek error: ${e.message?.slice(0, 60)}`);
      continue;
    }
  }
  return null;
}

// ─── Source 2: shahiid-anime.net (Secondary – confirmed working) ─────────────
// Navigation: search → /series/ → /seasons/ → episode list → /episodes/ + /?download=

async function tryShahiid(searchTitles, epNum, outFile, onProgress) {
  const ref = "https://shahiid-anime.net/";

  console.log(`[anime] 🔎 tryShahiid ep=${epNum} titles=[${searchTitles.join(", ")}]`);

  for (const query of searchTitles) {
    try {
      console.log(`[anime] 🌐 shahiid search: "${query}"`);
      const sRes = await axios.get(`https://shahiid-anime.net/?s=${encodeURIComponent(query)}`, {
        headers: UA, timeout: 15000
      });
      const $s = cheerio.load(sRes.data);

      // Collect ALL /seasons/ links and pick the best match
      const seasonsCandidates = [];
      $s("a[href*='/seasons/']").each((_, el) => {
        const h = $s(el).attr("href") || "";
        const txt = ($s(el).text() + " " + h).toLowerCase();
        // Score: prefer link that matches "season N" or query terms
        const qLower = query.toLowerCase();
        let score = 0;
        if (txt.includes(qLower)) score += 10;
        // Check for season number match (season 3, s3, الموسم 3...)
        const sNum = qLower.match(/season\s*(\d+)|s(\d+)|الموسم\s*(\d+)/)?.[1]
                  || qLower.match(/season\s*(\d+)|s(\d+)|الموسم\s*(\d+)/)?.[2]
                  || qLower.match(/season\s*(\d+)|s(\d+)|الموسم\s*(\d+)/)?.[3];
        if (sNum) {
          if (h.includes(`-season-${sNum}`) || h.includes(`-s${sNum}-`) ||
              txt.includes(`season ${sNum}`) || txt.includes(`الموسم ${sNum}`)) score += 20;
          if (txt.includes("final") || txt.includes("part")) score -= 5; // penalise finale/part when season num given
        }
        if (!seasonsCandidates.find(c => c.url === h)) seasonsCandidates.push({ url: h, score });
      });
      seasonsCandidates.sort((a, b) => b.score - a.score);
      console.log(`[anime] ↩️ موسم مرشح (${seasonsCandidates.length}): ${seasonsCandidates.slice(0,3).map(c=>`${c.score}:${c.url.split('/').slice(-2,-1)[0]}`).join(" | ")}`);
      if (!seasonsCandidates.length) continue;

      // Try each season candidate until we find one with valid episodes
      for (const { url: seasonsUrl } of seasonsCandidates.slice(0, 3)) {
        const epPageUrl = await shahiidFindEpisodePage(seasonsUrl, epNum);
        if (!epPageUrl) continue;

        console.log(`[anime] 🌐 shahiid epPage: ${epPageUrl}`);
        const eRes = await axios.get(epPageUrl, { headers: UA, timeout: 15000 });

        const allLinks = [];
        // embedded streams (highest priority)
        const pageStreams = extractStreams(eRes.data);
        console.log(`[anime] 🎬 shahiid ${pageStreams.length} stream(s) مدمج`);
        allLinks.push(...pageStreams);

        // iframe embeds
        const iframeStreams = await resolveIframeStreams(eRes.data, ref);
        allLinks.push(...iframeStreams);

        // external download links from episode page only (skip social/nav)
        const $e = cheerio.load(eRes.data);
        $e("a[href]").each((_, el) => {
          const h = $e(el).attr("href") || "";
          const t = $e(el).text().toLowerCase();
          if (!h.startsWith("http") || h.includes("shahiid")) return;
          const q = t.includes("1080") ? 4 : t.includes("720") ? 3 : t.includes("480") ? 2 : 1;
          allLinks.push({ url: h, q });
        });

        console.log(`[anime] 📄 shahiid ep=${epNum} → ${allLinks.length} رابط`);
        if (!allLinks.length) continue;

        const mb = await downloadBestLink(allLinks, outFile, ref, onProgress);
        if (mb) return { filePath: outFile, sizeMB: mb, source: "Shahiid Anime 📺 (عربي)" };
      }
    } catch (e) {
      console.log(`[anime] ⛔ tryShahiid err: ${e.message?.slice(0, 50)}`);
      continue;
    }
  }
  return null;
}

// Helper: fetches a shahiid season page and returns the URL of episode N
async function shahiidFindEpisodePage(seasonsUrl, epNum) {
  try {
    const aRes = await axios.get(seasonsUrl, { headers: { "User-Agent": UA["User-Agent"] }, timeout: 15000 });
    const $a = cheerio.load(aRes.data);
    const padded = String(epNum).padStart(2, "0");

    // Collect all /episodes/ links
    const epLinks = [];
    $a("a[href*='/episodes/']").each((_, el) => {
      const h = $a(el).attr("href");
      if (h && !epLinks.includes(h)) epLinks.push(h);
    });
    console.log(`[anime] ↩️ shahiid seasons page → ${epLinks.length} حلقة`);

    if (!epLinks.length) return null;

    // Try to find the right episode by number in URL
    for (const h of epLinks) {
      const inUrl = h.includes(`-${padded}-`) || h.includes(`-${epNum}-`)
                 || h.match(new RegExp(`[^0-9]0*${epNum}[^0-9]`));
      if (inUrl) { console.log(`[anime] ↩️ matched ep URL: ${h}`); return h; }
    }

    // Positional fallback — episode N = Nth link in page order
    const idx = epNum - 1;
    if (idx < epLinks.length) {
      console.log(`[anime] ↩️ positional ep URL[${idx}]: ${epLinks[idx]}`);
      return epLinks[idx];
    }
    return null;
  } catch (_) { return null; }
}

// ─── Source 3: animelek search fallback ──────────────────────────────────────
// When title slug guessing fails, search the site to find correct slug

async function tryAnimelekSearch(searchTitles, epNum, outFile, onProgress) {
  const epAr = "%D8%A7%D9%84%D8%AD%D9%84%D9%82%D8%A9";
  const ref = "https://animelek.vip/";

  for (const query of searchTitles) {
    try {
      const r = await axios.get(`https://animelek.vip/?s=${encodeURIComponent(query)}`, {
        headers: UA, timeout: 15000
      });
      const $ = cheerio.load(r.data);
      const slugs = new Set();
      $("a[href*='/anime/']").each((_, el) => {
        const h = $(el).attr("href") || "";
        const slug = h.match(/\/anime\/([^/]+)\/?$/)?.[1];
        if (slug) slugs.add(slug);
      });
      if (!slugs.size) continue;

      for (const slug of slugs) {
        const epUrl = `https://animelek.vip/episode/${slug}-${epNum}-${epAr}/`;
        try {
          const er = await axios.get(epUrl, { headers: UA, timeout: 12000 });
          if (er.status !== 200) continue;
          const $e = cheerio.load(er.data);
          const links = [];
          $e("a[href]").each((_, el) => {
            const h = $e(el).attr("href") || "";
            const t = $e(el).text().toLowerCase();
            if (!h.startsWith("http") || h.includes("animelek")) return;
            const q = t.includes("fhd") || t.includes("1080") ? 4 : t.includes("hd") || t.includes("720") ? 3 : 1;
            links.push({ url: h, q });
          });

          console.log(`[anime] 📄 animelek-search slug=${slug} ep=${epNum} → ${links.length} رابط`);
          if (!links.length) continue;
          const mb = await downloadBestLink(links, outFile, ref, onProgress);
          if (mb) return { filePath: outFile, sizeMB: mb, source: "AnimeLeK 🔍 (بحث)" };
        } catch (_) { continue; }
      }
    } catch (_) { continue; }
  }
  return null;
}

// ─── Main fetchEpisode ────────────────────────────────────────────────────────

async function fetchEpisode(animeTitle, epNum, seasonTitle, animeMeta, onProgress) {
  const titles = [seasonTitle, animeTitle].filter(Boolean);
  const outFile = path.join(TMP_DIR, `anime_${Date.now()}_ep${epNum}.mp4`);

  const slugCandidates = [];
  for (const t of titles) {
    const s = titleToSlug(t);
    if (s) slugCandidates.push(s);
  }
  if (animeMeta) {
    for (const s of getSlugsFromAnime(animeMeta)) {
      if (!slugCandidates.includes(s)) slugCandidates.push(s);
    }
  }

  console.log(`[anime] ════ fetchEpisode ════`);
  console.log(`[anime] title="${animeTitle}" season="${seasonTitle}" ep=${epNum}`);
  console.log(`[anime] slugs=[${slugCandidates.join(", ")}]`);

  // Note: tryShahiid removed — site uses JS-rendered episode pages, no usable links in static HTML
  const sources = [
    () => tryAnimelek(slugCandidates, epNum, outFile, onProgress),
    () => tryAnimelekSearch(titles, epNum, outFile, onProgress)
  ];

  for (const src of sources) {
    try {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      const result = await src();
      if (result) return result;
    } catch (_) { continue; }
  }

  return null;
}

// ─── Module ───────────────────────────────────────────────────────────────────

module.exports = {
  config: {
    name: "anime",
    aliases: ["اني", "انمي", "أنمي"],
    version: "3.0",
    author: "Saint",
    countDown: 10,
    role: 0,
    shortDescription: "ابحث وشاهد الأنمي بترجمة عربية",
    longDescription: "ابحث عن أنمي، استعرض مواسمه وحلقاته، وحمّلها من مصادر عربية مثل AniméSlayer وanimelek",
    category: "anime",
    guide: { en: "{pn} <اسم الأنمي>" }
  },

  onStart: async function ({ api, event, args, commandName }) {
    const { threadID, messageID } = event;
    const query = args.join(" ").trim();
    if (!query) return api.sendMessage("🎌 اكتب اسم الأنمي.\nمثال: /anime naruto\n/anime attack on titan", threadID, messageID);

    api.setMessageReaction("⏳", messageID, () => {}, true);
    try {
      const results = await searchAnime(query);
      if (!results.length) {
        api.setMessageReaction("❌", messageID, () => {}, true);
        return api.sendMessage(`❌ لم أجد أنمي باسم "${query}".`, threadID, messageID);
      }
      let body = `🔍 نتائج: "${query}"\n━━━━━━━━━━━━━━━━━━\n\n`;
      results.forEach((a, i) => {
        body += `${i + 1}️⃣ ${getTitle(a)}\n`;
        body += `   📺 ${a.episodes || "?"} حلقة | ${getStatus(a.status)} | ⭐${a.score || "?"}/10\n\n`;
      });
      body += "↩️ رد برقم الأنمي.";
      api.setMessageReaction("✅", messageID, () => {}, true);
      api.sendMessage(body, threadID, (err, info) => {
        if (!info) return;
        global.GoatBot.onReply.set(info.messageID, { commandName, author: event.senderID, state: "select_anime", results, messageID: info.messageID });
      });
    } catch (e) {
      api.setMessageReaction("❌", messageID, () => {}, true);
      api.sendMessage("❌ خطأ في البحث.", threadID, messageID);
    }
  },

  onReply: async function ({ api, event, Reply, commandName }) {
    const { threadID, messageID } = event;
    const { state } = Reply;
    if (event.senderID !== Reply.author) return;

    // ── اختيار الأنمي
    if (state === "select_anime") {
      const n = parseInt(event.body);
      if (isNaN(n) || n < 1 || n > Reply.results.length) return api.sendMessage(`❌ اختر 1-${Reply.results.length}.`, threadID, messageID);
      const basicAnime = Reply.results[n - 1];

      api.setMessageReaction("⏳", messageID, () => {}, true);

      // Fetch full details including relations
      let anime = basicAnime;
      try { anime = await getAnimeFull(basicAnime.mal_id); } catch (_) {}

      const title = getTitle(anime);
      const desc = (anime.synopsis || "").replace(/<[^>]+>/g, "").substring(0, 300);
      const genreNames = (anime.genres || []).map(g => g.name).join(", ");
      const seasons = buildSeasons(anime);

      api.setMessageReaction("✅", messageID, () => {}, true);

      let body = `🎌 ${title}\n━━━━━━━━━━━━━━━━━━\n`;
      body += `📺 الحلقات: ${anime.episodes || "?"} | ${getStatus(anime.status)}\n`;
      body += `⭐ التقييم: ${anime.score || "؟"}/10\n`;
      body += `📅 ${getSeason(anime.season)} ${anime.year || ""}\n`;
      body += `🎭 ${genreNames}\n\n`;
      if (desc) body += `📝 ${desc}...\n\n`;

      if (seasons.length > 1) {
        body += `🗂 المواسم:\n`;
        seasons.forEach(s => body += `  📌 ${s.label}: ${s.title} — ${s.episodes || "?"} حلقة\n`);
        body += `\n↩️ رد بـ "1" أو "الموسم 1" لاختيار الموسم.`;
      } else {
        const eps = anime.episodes || 0;
        body += `📋 الحلقات: ${eps > 0 ? `1 — ${eps}` : "غير محدد"}\n`;
        body += "↩️ رد برقم الحلقة لتحميلها.";
      }

      try { api.unsendMessage(Reply.messageID); } catch (_) {}
      api.sendMessage(body, threadID, (err, info) => {
        if (!info) return;
        global.GoatBot.onReply.set(info.messageID, {
          commandName, author: event.senderID,
          state: seasons.length > 1 ? "select_season" : "select_episode",
          seasons, animeTitle: title, animeMeta: anime,
          totalEpisodes: seasons.length === 1 ? (anime.episodes || basicAnime.episodes || 0) : 0,
          seasonTitle: getTitle(anime),
          messageID: info.messageID
        });
      });

    // ── اختيار الموسم
    } else if (state === "select_season") {
      const { seasons, animeTitle } = Reply;
      const m = event.body.match(/\d+/);
      if (!m) return api.sendMessage("❌ اكتب رقم الموسم. مثال: 1", threadID, messageID);
      const idx = parseInt(m[0]) - 1;
      if (idx < 0 || idx >= seasons.length) return api.sendMessage(`❌ اختر 1-${seasons.length}.`, threadID, messageID);
      const season = seasons[idx];
      const eps = season.episodes || 0;

      let body = `📺 ${animeTitle} — ${season.label}\n━━━━━━━━━━━━━━━━━━\n`;
      body += `🎌 ${season.title}\n📊 ${eps || "?"} حلقة | ${getStatus(season.status)}\n`;
      body += `📅 ${getSeason(season.season)} ${season.seasonYear || ""}\n\n`;
      if (eps > 0) {
        body += `📋 الحلقات:\n`;
        for (let r = 0; r < Math.ceil(eps / 10); r++) {
          const from = r * 10 + 1, to = Math.min((r + 1) * 10, eps);
          body += `  ${Array.from({ length: to - from + 1 }, (_, i) => from + i).join(" • ")}\n`;
        }
      }
      body += `\n↩️ رد برقم الحلقة لتحميلها.`;

      try { api.unsendMessage(Reply.messageID); } catch (_) {}
      api.sendMessage(body, threadID, (err, info) => {
        if (!info) return;
        global.GoatBot.onReply.set(info.messageID, {
          commandName, author: event.senderID, state: "select_episode",
          seasons, animeTitle, animeMeta: Reply.animeMeta, season, seasonTitle: season.title,
          seasonIdx: idx, totalEpisodes: eps, messageID: info.messageID
        });
      });

    // ── تحميل الحلقة
    } else if (state === "select_episode" || state === "navigate_episode") {
      const { animeTitle, season, seasons, seasonIdx, seasonTitle, totalEpisodes } = Reply;
      const input = event.body.trim().toLowerCase();

      let epNum = null;
      if (input === "next" && Reply.currentEp) epNum = Reply.currentEp + 1;
      else if (input === "prev" && Reply.currentEp) epNum = Math.max(1, Reply.currentEp - 1);
      else { const n = parseInt(event.body); if (!isNaN(n) && n > 0) epNum = n; }

      if (!epNum) return api.sendMessage("❌ اكتب رقم الحلقة.", threadID, messageID);
      if (totalEpisodes > 0 && epNum > totalEpisodes)
        return api.sendMessage(`❌ الحلقة ${epNum} غير موجودة. الحد الأقصى ${totalEpisodes}.`, threadID, messageID);

      const seasonLabel = season?.label || "الموسم 1";
      let waitMsgID = null;
      api.sendMessage(
        `⏳ جاري البحث عن الحلقة ${epNum} من ${animeTitle} — ${seasonLabel}\n🔍 مصادر: animelek ← shahiid-anime ← بحث...`,
        threadID, (e, info) => { if (info) waitMsgID = info.messageID; }
      );

      // ── Progress callback: edits the wait message with download bar ──────
      let lastEdit = 0;
      const onProgress = ({ pct, downloadedMB, totalMB }) => {
        const now = Date.now();
        if (now - lastEdit < 12000) return; // update at most every 12s
        lastEdit = now;
        if (!waitMsgID) return;
        const filled = Math.floor(pct / 10);
        const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
        const dlStr = downloadedMB.toFixed(0);
        const totStr = totalMB > 0 ? ` / ${totalMB.toFixed(0)} MB` : "";
        try {
          api.editMessage(
            `⬇️ جاري التحميل...\n${bar} ${pct}%\n📦 ${dlStr} MB${totStr}`,
            waitMsgID
          );
        } catch (_) {}
      };

      try {
        const result = await fetchEpisode(animeTitle, epNum, seasonTitle, Reply.animeMeta, onProgress);
        if (waitMsgID) try { api.unsendMessage(waitMsgID); } catch (_) {}

        if (!result) {
          return api.sendMessage(
            `❌ لم أجد الحلقة ${epNum} من ${animeTitle}.\n` +
            `💡 جرب رقماً مختلفاً أو تحقق من اسم الأنمي.`,
            threadID, messageID
          );
        }

        const body =
          `🎌 ${animeTitle} — ${seasonLabel}\n` +
          `📺 الحلقة ${epNum}\n` +
          `✅ المصدر: ${result.source}\n` +
          `📦 الحجم: ${result.sizeMB.toFixed(1)} MB`;

        api.sendMessage(
          { body, attachment: fs.createReadStream(result.filePath) },
          threadID,
          (err, info) => {
            try { fs.unlinkSync(result.filePath); } catch (_) {}
            if (!info) return;

            const hasNext = !totalEpisodes || epNum + 1 <= totalEpisodes;
            let nav = `✅ انتهت الحلقة ${epNum} من ${animeTitle}.\n\n`;
            if (hasNext) nav += `▶️ ↩️ رد بـ "next" للحلقة التالية.\n`;
            if (epNum > 1) nav += `◀️ ↩️ رد بـ "prev" للسابقة.\n`;
            nav += `↩️ أو رد برقم أي حلقة للانتقال إليها.`;

            api.sendMessage(nav, threadID, (e2, navInfo) => {
              if (!navInfo) return;
              global.GoatBot.onReply.set(navInfo.messageID, {
                commandName, author: event.senderID, state: "navigate_episode",
                animeTitle, animeMeta: Reply.animeMeta, season, seasons, seasonIdx, seasonTitle,
                totalEpisodes, currentEp: epNum, messageID: navInfo.messageID
              });
            });
          }
        );
        try { api.unsendMessage(Reply.messageID); } catch (_) {}

      } catch (e) {
        if (waitMsgID) try { api.unsendMessage(waitMsgID); } catch (_) {}
        console.error("[anime:dl]", e.message);
        api.sendMessage("❌ خطأ أثناء التحميل. جرب مرة أخرى.", threadID, messageID);
      }
    }
  }
};
