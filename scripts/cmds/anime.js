const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { exec } = require("child_process");
const ytSearch = require("yt-search");

const JIKAN = "https://api.jikan.moe/v4";
const TMP_DIR = path.join(process.cwd(), "scripts/cmds/tmp");
const MAX_MB = 1024;

fs.ensureDirSync(TMP_DIR);

// ─── Jikan API (metadata) ────────────────────────────────────────────────────

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
  if (s.includes("Finished")) return "منتهى ✅";
  if (s.includes("Airing") || s.includes("Currently")) return "يُعرض الآن 🟢";
  if (s.includes("Not yet")) return "قريباً 🔜";
  return s;
}

function getSeason(s) {
  return { winter: "شتاء ❄️", spring: "ربيع 🌸", summer: "صيف ☀️", fall: "خريف 🍂" }[s?.toLowerCase()] || (s || "");
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
      status: entry.status
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

// ─── YouTube search helper ────────────────────────────────────────────────────
// Returns duration in seconds from "mm:ss" or "hh:mm:ss" string
function parseDuration(ts) {
  if (!ts) return 0;
  const parts = ts.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

// Returns best matching YouTube video for an anime episode
async function findYouTubeVideo(queries, epNum) {
  const MIN_SEC = 12 * 60;  // 12 min (short episodes / specials)
  const MAX_SEC = 65 * 60;  // 65 min (double episodes / movies)

  for (const q of queries) {
    try {
      console.log(`[anime] 🔍 yt-search: "${q}"`);
      const result = await ytSearch(q);
      const videos = result?.videos || [];
      if (!videos.length) { console.log(`[anime] ⚠️ لا نتائج`); continue; }

      // Filter by duration (valid anime episode length)
      const valid = videos.filter(v => {
        const secs = parseDuration(v.timestamp);
        return secs >= MIN_SEC && secs <= MAX_SEC;
      });

      console.log(`[anime] 📺 ${videos.length} نتيجة، ${valid.length} بمدة صحيحة`);

      if (!valid.length) {
        // Fallback: take best result regardless of duration
        const best = videos[0];
        console.log(`[anime] ⚠️ fallback: "${best.title}" (${best.timestamp})`);
        return { url: `https://www.youtube.com/watch?v=${best.videoId}`, title: best.title, duration: best.timestamp };
      }

      const best = valid[0];
      console.log(`[anime] ✅ اختيار: "${best.title}" (${best.timestamp}) [${best.videoId}]`);
      return { url: `https://www.youtube.com/watch?v=${best.videoId}`, title: best.title, duration: best.timestamp };
    } catch (e) {
      console.log(`[anime] ❌ yt-search "${q}": ${e.message?.slice(0, 60)}`);
    }
  }
  return null;
}

// ─── Download via sagor-video-downloader ─────────────────────────────────────
// Preserves the original file extension (may be .webm, .mkv, .mp4, etc.)

async function downloadYouTube(ytUrl) {
  const { downloadVideo } = require("sagor-video-downloader");
  console.log(`[anime] ⬇️ downloadVideo: ${ytUrl}`);
  const result = await downloadVideo(ytUrl);
  if (!result?.filePath) throw new Error("sagor-video-downloader: no filePath returned");
  if (!fs.existsSync(result.filePath)) throw new Error(`sagor-video-downloader: file not found: ${result.filePath}`);

  // Move to TMP_DIR while keeping the original filename + extension
  const safePath = path.join(TMP_DIR, path.basename(result.filePath));
  if (result.filePath !== safePath) {
    fs.moveSync(result.filePath, safePath, { overwrite: true });
  }
  console.log(`[anime] 📁 saved: ${safePath} (${(fs.statSync(safePath).size / 1048576).toFixed(1)} MB)`);
  return safePath;
}

// ─── Consumet API fallback ────────────────────────────────────────────────────
// (public instances are unreliable but worth trying as fallback)

const CONSUMET = ["https://consumet-api.onrender.com"];

async function consumetGet(path_) {
  for (const base of CONSUMET) {
    try {
      const r = await axios.get(`${base}${path_}`, { timeout: 18000 });
      if (r.status === 200 && r.data) return r.data;
    } catch (_) {}
  }
  return null;
}

function downloadWithFFmpeg(videoUrl, referer, outFile) {
  return new Promise((resolve, reject) => {
    const ref = (referer || "").replace(/"/g, "");
    const cmd = `ffmpeg -y ${ref ? `-headers "Referer: ${ref}"` : ""} -i "${videoUrl}" -c copy "${outFile}" 2>&1`;
    console.log(`[anime] 🎬 ffmpeg → ${videoUrl.slice(0, 70)}`);
    exec(cmd, { timeout: 720000 }, (err) => {
      if (err) return reject(new Error(err.message?.slice(0, 120)));
      resolve(outFile);
    });
  });
}

function checkFile(outFile) {
  if (!fs.existsSync(outFile)) return null;
  const mb = fs.statSync(outFile).size / 1048576;
  return mb > 1 && mb <= MAX_MB ? mb : null;
}

async function tryConsumetGogoanime(titles, epNum, outFile) {
  for (const q of titles) {
    try {
      const data = await consumetGet(`/anime/gogoanime/${encodeURIComponent(q)}`);
      const results = data?.results || [];
      if (!results.length) continue;
      const match = results.find(r => !r.id?.includes("-dub")) || results[0];
      const info = await consumetGet(`/anime/gogoanime/info/${match.id}`);
      const ep = (info?.episodes || []).find(e => parseInt(e.number) === epNum);
      if (!ep) continue;
      const watch = await consumetGet(`/anime/gogoanime/watch/${ep.id}`);
      const sources = watch?.sources || [];
      const best = sources.find(s => s.quality === "1080p") || sources.find(s => s.quality === "720p") || sources.find(s => s.isM3U8) || sources[0];
      if (!best) continue;
      const referer = watch?.headers?.Referer || "";
      if (best.isM3U8) {
        await downloadWithFFmpeg(best.url, referer, outFile);
      } else {
        const res = await axios.get(best.url, { responseType: "stream", headers: { Referer: referer }, timeout: 720000 });
        const writer = fs.createWriteStream(outFile);
        res.data.pipe(writer);
        await new Promise((ok, fail) => { writer.on("finish", ok); writer.on("error", fail); });
      }
      const mb = checkFile(outFile);
      if (mb) return { filePath: outFile, sizeMB: mb, source: `GogoAnime 🎬 [${best.quality || "auto"}]` };
    } catch (e) {
      console.log(`[anime] ❌ consumet gogoanime "${q}": ${e.message?.slice(0, 60)}`);
    }
  }
  return null;
}

// ─── Main fetchEpisode ────────────────────────────────────────────────────────

async function fetchEpisode(animeTitle, epNum, seasonTitle, animeMeta, onProgress) {
  // outFile used only for ffmpeg-based sources (consumet). YouTube uses its own path.
  const outFile = path.join(TMP_DIR, `anime_${Date.now()}_ep${epNum}.mp4`);

  // Build search title list from Jikan metadata
  const titles = [];
  if (animeMeta?.title_english) titles.push(animeMeta.title_english);
  if (animeMeta?.title) titles.push(animeMeta.title);
  if (seasonTitle && !titles.includes(seasonTitle)) titles.push(seasonTitle);
  if (animeTitle && !titles.includes(animeTitle)) titles.push(animeTitle);
  const baseTitle = titles[0] || animeTitle;

  console.log(`[anime] ════ fetchEpisode ════`);
  console.log(`[anime] title="${animeTitle}" season="${seasonTitle}" ep=${epNum}`);
  console.log(`[anime] base="${baseTitle}"`);

  // ── Source 1: YouTube Arabic sub ─────────────────────────────────────────
  try {
    const ytQueries = [
      `${baseTitle} episode ${epNum} arabic sub مترجم عربي`,
      `${baseTitle} الحلقة ${epNum} مترجم`,
      `${baseTitle} ep ${epNum} arabic`,
    ];
    const yt = await findYouTubeVideo(ytQueries, epNum);
    if (yt) {
      const filePath = await downloadYouTube(yt.url);
      const mb = checkFile(filePath);
      if (mb) {
        console.log(`[anime] ✅ نجح YouTube Arabic: ${mb.toFixed(1)} MB | ${filePath}`);
        return { filePath, sizeMB: mb, source: "YouTube 📺 (عربي)" };
      }
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.log(`[anime] ❌ YouTube Arabic: ${e.message?.slice(0, 80)}`);
  }

  // ── Source 2: YouTube English sub ────────────────────────────────────────
  try {
    const ytQueries = [
      `${baseTitle} episode ${epNum} english sub`,
      `${baseTitle} episode ${epNum} sub`,
      `${baseTitle} ep ${epNum}`,
    ];
    const yt = await findYouTubeVideo(ytQueries, epNum);
    if (yt) {
      const filePath = await downloadYouTube(yt.url);
      const mb = checkFile(filePath);
      if (mb) {
        console.log(`[anime] ✅ نجح YouTube EN: ${mb.toFixed(1)} MB | ${filePath}`);
        return { filePath, sizeMB: mb, source: "YouTube 📺 (إنجليزي)" };
      }
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.log(`[anime] ❌ YouTube English: ${e.message?.slice(0, 80)}`);
  }

  // ── Source 3: Consumet GogoAnime (fallback) ───────────────────────────────
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  try {
    const result = await tryConsumetGogoanime(titles, epNum, outFile);
    if (result) return result;
  } catch (e) {
    console.log(`[anime] ❌ consumet: ${e.message?.slice(0, 60)}`);
  }

  return null;
}

// ─── Module ───────────────────────────────────────────────────────────────────

module.exports = {
  config: {
    name: "anime",
    aliases: ["اني", "انمي", "أنمي"],
    version: "4.1",
    author: "Saint",
    countDown: 10,
    role: 0,
    shortDescription: "ابحث وحمّل الأنمي",
    longDescription: "ابحث عن أنمي، استعرض مواسمه وحلقاته، وحمّلها",
    category: "anime",
    guide: { en: "{pn} <اسم الأنمي>" }
  },

  onStart: async function ({ api, event, args }) {
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
        global.GoatBot.onReply.set(info.messageID, {
          commandName: "anime", author: event.senderID,
          state: "select_anime", results, messageID: info.messageID
        });
      });
    } catch (e) {
      api.setMessageReaction("❌", messageID, () => {}, true);
      api.sendMessage("❌ خطأ في البحث.", threadID, messageID);
    }
  },

  onReply: async function ({ api, event, Reply }) {
    const { threadID, messageID } = event;
    const { state } = Reply;
    if (event.senderID !== Reply.author) return;

    // ── اختيار الأنمي
    if (state === "select_anime") {
      const n = parseInt(event.body);
      if (isNaN(n) || n < 1 || n > Reply.results.length)
        return api.sendMessage(`❌ اختر 1-${Reply.results.length}.`, threadID, messageID);

      const basicAnime = Reply.results[n - 1];
      api.setMessageReaction("⏳", messageID, () => {}, true);

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
          commandName: "anime", author: event.senderID,
          state: seasons.length > 1 ? "select_season" : "select_episode",
          seasons, animeTitle: title, animeMeta: anime,
          totalEpisodes: seasons.length === 1 ? (anime.episodes || basicAnime.episodes || 0) : 0,
          seasonTitle: getTitle(anime), messageID: info.messageID
        });
      });

    // ── اختيار الموسم
    } else if (state === "select_season") {
      const { seasons, animeTitle } = Reply;
      const m = event.body.match(/\d+/);
      if (!m) return api.sendMessage("❌ اكتب رقم الموسم. مثال: 1", threadID, messageID);
      const idx = parseInt(m[0]) - 1;
      if (idx < 0 || idx >= seasons.length)
        return api.sendMessage(`❌ اختر 1-${seasons.length}.`, threadID, messageID);

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
          commandName: "anime", author: event.senderID, state: "select_episode",
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
        `⏳ جاري البحث عن الحلقة ${epNum} من ${animeTitle} — ${seasonLabel}\n🔍 يوتيوب (مترجم عربي) ← إنجليزي ← مصادر أخرى...`,
        threadID, (e, info) => { if (info) waitMsgID = info.messageID; }
      );

      const onProgress = ({ pct, downloadedMB, totalMB }) => {
        if (!waitMsgID) return;
        const filled = Math.floor(pct / 10);
        const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
        const totStr = totalMB > 0 ? ` / ${totalMB.toFixed(0)} MB` : "";
        try {
          api.editMessage(
            `⬇️ جاري التحميل...\n${bar} ${pct}%\n📦 ${downloadedMB.toFixed(0)} MB${totStr}`,
            waitMsgID
          );
        } catch (_) {}
      };

      try {
        const result = await fetchEpisode(animeTitle, epNum, seasonTitle, Reply.animeMeta, onProgress);
        if (waitMsgID) try { api.unsendMessage(waitMsgID); } catch (_) {}

        if (!result) {
          return api.sendMessage(
            `❌ لم أجد الحلقة ${epNum} من ${animeTitle}.\n💡 جرب اسم الأنمي بالإنجليزي.`,
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
                commandName: "anime", author: event.senderID, state: "navigate_episode",
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
