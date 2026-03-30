const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

const API = "https://api.mangadex.org";
const MB_BASE = "https://mangabuddy.com";
const CACHE = path.join(__dirname, "cache");
const CHAPTERS_PER_PAGE = 25;
const PAGE_BATCH = 30;

const MB_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": MB_BASE + "/"
};

const MB_NAV = new Set(["home","popular","latest","manga-list","discussions","settings",
  "bookmarks","history","notifications","search","genres","az-list","contact",
  "privacy-policy","terms-of-service","dmca","newest","login","register"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTitle(manga) {
  const t = manga.attributes.title;
  return t.en || t["ko-ro"] || t.ko_ro || t["ja-ro"] || Object.values(t)[0] || "Unknown";
}

function getLangFlag(lang) {
  return lang === "ar" ? "🇸🇦" : lang === "en" ? "🇬🇧" : lang === "ko" ? "🇰🇷" : lang === "zh" ? "🇨🇳" : `[${lang}]`;
}

function getTypeLabel(lang) {
  if (lang === "ko") return "📗 مانهوا";
  if (lang === "zh" || lang === "zh-hk") return "📘 مانهوا صينية";
  return "📗 مانهوا";
}

function getStatusLabel(s) {
  return { ongoing: "مستمرة 🟢", completed: "مكتملة ✅", hiatus: "متوقفة ⏸", cancelled: "ملغاة ❌" }[s] || s || "—";
}

// ─── MangaDex API ─────────────────────────────────────────────────────────────

const RATINGS = ["safe", "suggestive", "erotica"];

function buildQ(query, { langs = [], origLangs = [], limit = 15 } = {}) {
  const p = [
    `title=${encodeURIComponent(query)}`,
    `limit=${limit}`,
    "order[relevance]=desc",
    "includes[]=cover_art"
  ];
  langs.forEach(l => p.push(`availableTranslatedLanguage[]=${l}`));
  origLangs.forEach(l => p.push(`originalLanguage[]=${l}`));
  RATINGS.forEach(r => p.push(`contentRating[]=${r}`));
  return `${API}/manga?${p.join("&")}`;
}

async function mdGet(url) {
  try {
    const res = await axios.get(url, { timeout: 25000 });
    return res.data.data || [];
  } catch (e) {
    console.log("[manhwa:search_fail]", e.message?.slice(0, 60));
    return [];
  }
}

async function searchManhwa(query) {
  const KO_ZH = ["ko", "zh", "zh-hk"];
  const [arKo, arAll, koAny, fullBroad] = await Promise.all([
    mdGet(buildQ(query, { langs: ["ar"], origLangs: KO_ZH, limit: 15 })),
    mdGet(buildQ(query, { langs: ["ar"], origLangs: [], limit: 15 })),
    mdGet(buildQ(query, { langs: ["ar", "en"], origLangs: KO_ZH, limit: 15 })),
    mdGet(buildQ(query, { langs: [], origLangs: [], limit: 20 }))
  ]);

  const seen = new Set();
  const merged = [];
  for (const list of [arKo, arAll, koAny, fullBroad]) {
    for (const m of list) {
      if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
    }
  }
  merged.sort((a, b) => {
    const aAr = a.attributes.availableTranslatedLanguages?.includes("ar") ? 0 : 1;
    const bAr = b.attributes.availableTranslatedLanguages?.includes("ar") ? 0 : 1;
    return aAr - bAr;
  });
  return merged.slice(0, 15);
}

async function getDxArabicChapters(mangaId) {
  let all = [];
  let offset = 0;
  const limit = 96;
  while (true) {
    const p = [
      "translatedLanguage[]=ar",
      "order[chapter]=asc", "order[volume]=asc",
      `limit=${limit}`, `offset=${offset}`,
      "contentRating[]=safe", "contentRating[]=suggestive",
      "contentRating[]=erotica", "contentRating[]=pornographic"
    ];
    try {
      const res = await axios.get(`${API}/manga/${mangaId}/feed?${p.join("&")}`, { timeout: 25000 });
      const data = res.data.data || [];
      all = all.concat(data);
      if (all.length >= (res.data.total || 0) || data.length < limit) break;
      offset += limit;
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.log("[manhwa:feed_error]", e.message?.slice(0, 60));
      break;
    }
  }
  return all;
}

async function getDxChapterPages(chapterId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(`${API}/at-home/server/${chapterId}`, { timeout: 20000 });
      const { baseUrl, chapter } = res.data;
      if (!chapter?.data?.length) throw new Error("no pages");
      return chapter.data.map(f => `${baseUrl}/data/${chapter.hash}/${f}`);
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

// ─── MangaBuddy API ───────────────────────────────────────────────────────────

async function mbSearch(query) {
  try {
    const res = await axios.get(`${MB_BASE}/search?q=${encodeURIComponent(query)}`, {
      timeout: 15000, headers: MB_HEADERS
    });
    const links = [...new Set(res.data.match(/href="\/([a-z0-9-]+)"/g) || [])];
    const slugs = links
      .map(l => l.replace(/^href="\//, "").replace(/"$/, ""))
      .filter(l => l.length > 2 && !MB_NAV.has(l));
    return slugs.length > 0 ? slugs[0] : null;
  } catch (_) { return null; }
}

async function mbGetChapters(mangaSlug) {
  try {
    const res = await axios.get(`${MB_BASE}/${mangaSlug}`, {
      timeout: 15000, headers: MB_HEADERS
    });
    const matches = [...res.data.matchAll(/href="\/[a-z0-9-]+\/(chapter-[a-z0-9-]+)"/g)];
    const seen = new Set();
    const chapters = [];
    for (const m of matches) {
      const slug = m[1];
      const numMatch = slug.match(/chapter-(\d+(?:\.\d+)?)/);
      if (!numMatch) continue;
      const num = numMatch[1];
      if (seen.has(num)) continue;
      seen.add(num);
      chapters.push({ num, slug, mangaSlug });
    }
    chapters.sort((a, b) => parseFloat(a.num) - parseFloat(b.num));
    return chapters;
  } catch (_) { return []; }
}

async function mbGetChapterImages(mangaSlug, chapterSlug) {
  const res = await axios.get(`${MB_BASE}/${mangaSlug}/${chapterSlug}`, {
    timeout: 20000, headers: MB_HEADERS
  });
  const chapImages = res.data.match(/var chapImages = '([^']+)'/)?.[1];
  if (!chapImages) throw new Error("chapImages not found");
  return chapImages.split(",").filter(u => u.startsWith("http"));
}

// ─── Unified chapters ──────────────────────────────────────────────────────────

function buildUnifiedChapters(mbChapters, dxArChapters) {
  const dxArMap = new Map();
  for (const ch of dxArChapters) {
    const num = ch.attributes.chapter || "0";
    if (!dxArMap.has(num)) dxArMap.set(num, ch);
  }

  const chapters = mbChapters.map(mb => {
    const dxCh = dxArMap.get(mb.num);
    return {
      num: mb.num,
      flag: dxCh ? "🇸🇦" : "🇬🇧",
      title: dxCh?.attributes?.title || "",
      dxId: dxCh?.id || null,
      mbSlug: mb.slug,
      mbMangaSlug: mb.mangaSlug
    };
  });

  if (chapters.length === 0 && dxArChapters.length > 0) {
    const seen = new Map();
    for (const ch of dxArChapters) {
      const num = ch.attributes.chapter || "0";
      if (!seen.has(num)) seen.set(num, ch);
    }
    return [...seen.values()]
      .sort((a, b) => parseFloat(a.attributes.chapter || 0) - parseFloat(b.attributes.chapter || 0))
      .map(ch => ({
        num: ch.attributes.chapter || "؟",
        flag: getLangFlag(ch.attributes.translatedLanguage),
        title: ch.attributes.title || "",
        dxId: ch.id,
        mbSlug: null,
        mbMangaSlug: null
      }));
  }

  return chapters;
}

function buildChapterList(mangaTitle, chapters, page, source) {
  const totalPages = Math.ceil(chapters.length / CHAPTERS_PER_PAGE);
  const start = page * CHAPTERS_PER_PAGE;
  const slice = chapters.slice(start, start + CHAPTERS_PER_PAGE);
  const arCount = chapters.filter(c => c.flag === "🇸🇦").length;

  let body = `📗 ${mangaTitle}\n`;
  body += `📚 ${chapters.length} فصل`;
  if (arCount > 0) body += ` | 🇸🇦 ${arCount} بالعربية`;
  if (source === "mb") body += ` | 🇬🇧 إنجليزي`;
  body += ` · صفحة ${page + 1}/${totalPages}\n`;
  body += "━━━━━━━━━━━━━━━━━━\n\n";

  slice.forEach(ch => {
    const title = ch.title ? ` — ${ch.title.slice(0, 28)}` : "";
    body += `${ch.flag} فصل ${ch.num}${title}\n`;
  });

  body += "\n↩️ رد برقم الفصل لقراءته.";
  if (start + CHAPTERS_PER_PAGE < chapters.length) body += '\n↩️ "next" للصفحة التالية.';
  if (page > 0) body += '\n↩️ "prev" للصفحة السابقة.';
  return body;
}

// ─── إرسال الصفحات ────────────────────────────────────────────────────────────

async function downloadPage(url, filePath, referer, attempt = 0) {
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 35000,
      headers: { "Referer": referer, "User-Agent": MB_HEADERS["User-Agent"] }
    });
    fs.writeFileSync(filePath, Buffer.from(res.data));
    return true;
  } catch (e) {
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 1000));
      return downloadPage(url, filePath, referer, attempt + 1);
    }
    console.log("[manhwa:page_fail]", e.message?.slice(0, 50));
    return false;
  }
}

async function sendChapterPages(api, event, chapter, mangaTitle, chapters, currentIndex, commandName) {
  const { threadID } = event;
  const chNum = chapter.num;

  let waitMsgID = null;
  await new Promise(resolve => {
    api.sendMessage(
      `⏳ جاري تحميل ${chapter.flag} فصل ${chNum}\n📗 "${mangaTitle}"`,
      threadID,
      (err, info) => { if (info) waitMsgID = info.messageID; resolve(); }
    );
  });

  try {
    fs.ensureDirSync(CACHE);

    let pages = [];
    let langUsed = chapter.flag;
    let referer = "https://mangadex.org";

    if (chapter.dxId) {
      try {
        pages = await getDxChapterPages(chapter.dxId);
        langUsed = "🇸🇦";
        referer = "https://mangadex.org";
      } catch (e) {
        console.error("[manhwa:dx-pages]", e.message, "→ MangaBuddy fallback");
      }
    }

    if (pages.length === 0 && chapter.mbSlug && chapter.mbMangaSlug) {
      pages = await mbGetChapterImages(chapter.mbMangaSlug, chapter.mbSlug);
      langUsed = "🇬🇧";
      referer = MB_BASE + "/";
    }

    if (pages.length === 0) throw new Error("No images found");

    const totalBatches = Math.ceil(pages.length / PAGE_BATCH);

    for (let i = 0; i < pages.length; i += PAGE_BATCH) {
      const batch = pages.slice(i, i + PAGE_BATCH);
      const pageFiles = [];

      for (let j = 0; j < batch.length; j++) {
        const url = batch[j];
        const ext = path.extname(url.split("?")[0]).replace(".", "") || "jpg";
        const filePath = path.join(CACHE, `manhwa_ch${chNum}_p${i + j + 1}.${ext}`);
        const ok = await downloadPage(url, filePath, referer);
        if (ok) pageFiles.push(filePath);
      }

      if (!pageFiles.length) continue;

      const batchNum = Math.floor(i / PAGE_BATCH) + 1;
      const body =
        `📗 ${mangaTitle}\n` +
        `${langUsed} فصل ${chNum}\n` +
        `🖼 الصفحات ${i + 1}–${i + pageFiles.length} من ${pages.length}` +
        (totalBatches > 1 ? ` (جزء ${batchNum}/${totalBatches})` : "");

      await new Promise(resolve => {
        api.sendMessage(
          { body, attachment: pageFiles.map(f => fs.createReadStream(f)) },
          threadID,
          () => { pageFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} }); resolve(); }
        );
      });
    }

    if (waitMsgID) try { api.unsendMessage(waitMsgID); } catch (_) {}

    const prev = currentIndex > 0 ? chapters[currentIndex - 1] : null;
    const next = chapters[currentIndex + 1];
    let nav = `✅ انتهى ${langUsed} فصل ${chNum} من "${mangaTitle}".\n\n`;
    if (next) nav += `▶️ ↩️ "next" — فصل ${next.num} ${next.flag}\n`;
    if (prev) nav += `◀️ ↩️ "prev" — فصل ${prev.num} ${prev.flag}\n`;
    nav += `↩️ أو رد برقم أي فصل.`;

    api.sendMessage(nav, threadID, (err, info) => {
      if (err || !info) return;
      global.GoatBot.onReply.set(info.messageID, {
        commandName, author: event.senderID, state: "navigate_chapter",
        chapters, currentIndex, mangaTitle, messageID: info.messageID
      });
    });

  } catch (e) {
    if (waitMsgID) try { api.unsendMessage(waitMsgID); } catch (_) {}
    throw e;
  }
}

// ─── Module ───────────────────────────────────────────────────────────────────

module.exports = {
  config: {
    name: "manhwa",
    aliases: ["مانهوا", "manhua", "مانهوا-صينية", "webtoon", "ويب-تون", "manhwas"],
    version: "3.0",
    author: "Saint",
    countDown: 5,
    role: 0,
    shortDescription: "اقرأ المانهوا الكورية والصينية — فصول كاملة",
    longDescription: "ابحث عن أي مانهوا — الفصول العربية من MangaDex والفصول الإنجليزية الكاملة من MangaBuddy",
    category: "anime",
    guide: {
      en: "{pn} <اسم المانهوا>\nمثال:\n{pn} solo leveling\n{pn} tower of god\n{pn} noblesse\n{pn} omniscient reader\n{pn} true beauty\n{pn} lookism"
    }
  },

  onStart: async function ({ api, event, args, commandName }) {
    const { threadID, messageID } = event;
    const query = args.join(" ").trim();

    if (!query) {
      return api.sendMessage(
        "📗 اكتب اسم المانهوا.\n\nأمثلة شهيرة:\n/manhwa solo leveling\n/manhwa tower of god\n/manhwa noblesse\n/manhwa omniscient reader\n/manhwa the beginning after the end\n/manhwa lookism\n/manhwa true beauty\n/manhwa windbreaker\n\n🇸🇦 عربي من MangaDex | 🇬🇧 إنجليزي كامل من MangaBuddy",
        threadID, messageID
      );
    }

    api.setMessageReaction("⏳", messageID, () => {}, true);

    try {
      const results = await searchManhwa(query);

      if (!results.length) {
        api.setMessageReaction("❌", messageID, () => {}, true);
        return api.sendMessage(
          `❌ لم أجد نتائج لـ "${query}".\n\n💡 نصائح:\n- اكتب الاسم بالإنجليزي\n- جرب اسماً مختصراً\n- مثال: solo leveling`,
          threadID, messageID
        );
      }

      let body = `🔍 نتائج: "${query}"\n━━━━━━━━━━━━━━━━━━\n\n`;
      results.forEach((manga, i) => {
        const title = getTitle(manga);
        const type = getTypeLabel(manga.attributes.originalLanguage);
        const status = getStatusLabel(manga.attributes.status);
        const chCount = manga.attributes.lastChapter || "?";
        const hasAr = manga.attributes.availableTranslatedLanguages?.includes("ar");
        const langBadge = hasAr ? "🇸🇦 عربي" : "🇬🇧 إنجليزي";
        body += `${i + 1}️⃣ ${title}\n`;
        body += `   ${type} · ${status} · فصل ${chCount} · ${langBadge}\n\n`;
      });
      body += "↩️ رد برقم للقراءة.";

      api.setMessageReaction("✅", messageID, () => {}, true);
      api.sendMessage(body, threadID, (err, info) => {
        if (err || !info) return;
        global.GoatBot.onReply.set(info.messageID, {
          commandName, author: event.senderID,
          state: "select_manga", results, messageID: info.messageID
        });
      });

    } catch (e) {
      console.error("[manhwa:search]", e.message);
      api.setMessageReaction("❌", messageID, () => {}, true);
      api.sendMessage("❌ خطأ في البحث. جرب مرة أخرى.", threadID, messageID);
    }
  },

  onReply: async function ({ api, event, Reply, commandName }) {
    const { threadID, messageID } = event;
    const { state } = Reply;
    if (event.senderID !== Reply.author) return;

    // ── اختيار مانهوا
    if (state === "select_manga") {
      const n = parseInt(event.body);
      if (isNaN(n) || n < 1 || n > Reply.results.length)
        return api.sendMessage(`❌ اختر رقماً بين 1 و${Reply.results.length}.`, threadID, messageID);

      const manga = Reply.results[n - 1];
      const title = getTitle(manga);
      const type = getTypeLabel(manga.attributes.originalLanguage);
      const desc = (manga.attributes.description?.en || manga.attributes.description?.ar || "")
        .replace(/<[^>]+>/g, "").slice(0, 180);
      const genres = (manga.attributes.tags || [])
        .filter(t => t.attributes.group === "genre")
        .map(t => t.attributes.name.en || Object.values(t.attributes.name)[0])
        .slice(0, 5).join(" · ");

      api.setMessageReaction("⏳", messageID, () => {}, true);

      try {
        const [dxArChapters, mbSlug] = await Promise.all([
          getDxArabicChapters(manga.id),
          mbSearch(title)
        ]);

        let mbChapters = [];
        if (mbSlug) mbChapters = await mbGetChapters(mbSlug);

        const chapters = buildUnifiedChapters(mbChapters, dxArChapters);

        if (!chapters.length) {
          api.setMessageReaction("❌", messageID, () => {}, true);
          return api.sendMessage(
            `❌ لا توجد فصول متاحة لـ "${title}".\n💡 جرب مانهوا أخرى.`,
            threadID, messageID
          );
        }

        const arCount = chapters.filter(c => c.flag === "🇸🇦").length;
        const source = mbChapters.length > 0 ? "mb" : "dx";

        let sourceNote = source === "mb"
          ? (arCount > 0
            ? `\n🇸🇦 ${arCount} فصل بالعربية · 🇬🇧 ${chapters.length} فصل بالإنجليزية`
            : `\n🇬🇧 ${chapters.length} فصل بالإنجليزية (لا يوجد عربي)`)
          : `\n🇸🇦 ${arCount} فصل بالعربية`;

        api.setMessageReaction("✅", messageID, () => {}, true);

        let body = `${type} ${title}\n━━━━━━━━━━━━━━━━━━\n`;
        body += `📚 ${chapters.length} فصل | ${getStatusLabel(manga.attributes.status)}`;
        body += sourceNote + "\n";
        if (genres) body += `🏷 ${genres}\n`;
        if (desc) body += `\n📝 ${desc}...\n\n`;
        body += buildChapterList(title, chapters, 0, source);

        api.sendMessage(body, threadID, (err, info) => {
          if (err || !info) return;
          global.GoatBot.onReply.set(info.messageID, {
            commandName, author: event.senderID,
            state: "browse_chapters", chapters, mangaTitle: title, page: 0, source,
            messageID: info.messageID
          });
        });
        try { api.unsendMessage(Reply.messageID); } catch (_) {}

      } catch (e) {
        console.error("[manhwa:chapters]", e.message);
        api.setMessageReaction("❌", messageID, () => {}, true);
        api.sendMessage("❌ خطأ في جلب الفصول. جرب مرة أخرى.", threadID, messageID);
      }

    // ── تصفح الفصول
    } else if (state === "browse_chapters") {
      const { chapters, mangaTitle, page, source } = Reply;
      const input = event.body.trim().toLowerCase();
      const totalPages = Math.ceil(chapters.length / CHAPTERS_PER_PAGE);

      if (input === "next" || input === "prev") {
        const newPage = input === "next" ? page + 1 : page - 1;
        if (newPage < 0 || newPage >= totalPages)
          return api.sendMessage("❌ لا توجد صفحات أخرى.", threadID, messageID);
        const body = buildChapterList(mangaTitle, chapters, newPage, source);
        api.sendMessage(body, threadID, (err, info) => {
          if (err || !info) return;
          global.GoatBot.onReply.set(info.messageID, {
            commandName, author: event.senderID,
            state: "browse_chapters", chapters, mangaTitle, page: newPage, source,
            messageID: info.messageID
          });
        });
        try { api.unsendMessage(Reply.messageID); } catch (_) {}
        return;
      }

      const chapter = chapters.find(ch => String(ch.num) === input);
      if (!chapter)
        return api.sendMessage(
          `❌ الفصل "${input}" غير موجود.\n💡 تأكد من الرقم الموجود في القائمة.`,
          threadID, messageID
        );

      const currentIndex = chapters.indexOf(chapter);
      try {
        await sendChapterPages(api, event, chapter, mangaTitle, chapters, currentIndex, commandName);
        try { api.unsendMessage(Reply.messageID); } catch (_) {}
      } catch (e) {
        console.error("[manhwa:pages]", e.message);
        api.sendMessage("❌ خطأ في تحميل الفصل. جرب مرة أخرى.", threadID, messageID);
      }

    // ── التنقل بين الفصول
    } else if (state === "navigate_chapter") {
      const { chapters, mangaTitle, currentIndex } = Reply;
      const input = event.body.trim().toLowerCase();

      let targetIndex = currentIndex;
      if (input === "next") targetIndex = currentIndex + 1;
      else if (input === "prev") targetIndex = currentIndex - 1;
      else {
        const found = chapters.findIndex(ch => String(ch.num) === event.body.trim());
        if (found !== -1) targetIndex = found;
      }

      if (targetIndex < 0 || targetIndex >= chapters.length)
        return api.sendMessage("❌ لا يوجد فصل في هذا الاتجاه.", threadID, messageID);

      try {
        await sendChapterPages(api, event, chapters[targetIndex], mangaTitle, chapters, targetIndex, commandName);
        try { api.unsendMessage(Reply.messageID); } catch (_) {}
      } catch (e) {
        console.error("[manhwa:navigate]", e.message);
        api.sendMessage("❌ خطأ في تحميل الفصل.", threadID, messageID);
      }
    }
  }
};
