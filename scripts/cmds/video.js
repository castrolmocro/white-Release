const fs = require("fs");
const path = require("path");
const ytSearch = require("yt-search");
const { downloadVideo } = require("sagor-video-downloader");

function sendMsg(message, body) {
  return new Promise(resolve => message.reply(body, (err, info) => resolve(info?.messageID || null)));
}

function formatViews(n) {
  if (!n) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toLocaleString();
}

module.exports = {
  config: {
    name: "فيديو",
    aliases: ["v", "video", "دونلواد", "يوتيوب", "yt"],
    version: "3.0",
    author: "Saint+djamel",
    countDown: 8,
    role: 0,
    shortDescription: "بحث وتحميل فيديو من يوتيوب",
    longDescription: "ابحث عن فيديو أو أغنية من يوتيوب بالاسم وسيتم تحميله وإرساله مباشرة",
    category: "media",
    guide: "{pn} [اسم الفيديو أو الأغنية]"
  },

  onStart: async function ({ api, event, args, message }) {
    const query = args.join(" ").trim();
    if (!query) return message.reply("🔍 اكتب اسم الفيديو أو الأغنية بعد الأمر.\nمثال: .فيديو despacito\nمثال: .فيديو اغنية حزينة");

    const waitingID = await sendMsg(message, "◈ ↞جاري البحث..〔 ! 〕\n◈ WHITE𝗮⃪\n━━━━━━━━━━━━━");

    function unsendWaiting() {
      if (waitingID) api.unsendMessage(waitingID).catch(() => {});
    }

    try {
      const results = await ytSearch(query);
      if (!results?.videos?.length) {
        unsendWaiting();
        return message.reply(❌ لم أجد نتائج لـ "${query}"\nجرب كتابة اسم آخر.);
      }

      const candidates = results.videos.slice(0, 3);
      let downloaded = null;
      let chosenVideo = null;

      for (const video of candidates) {
        try {
          const ytUrl = https://www.youtube.com/watch?v=${video.videoId};
          const result = await downloadVideo(ytUrl);

          if (!result?.filePath || !fs.existsSync(result.filePath)) continue;

          const stats = fs.statSync(result.filePath);
          const sizeMB = stats.size / (1024 * 1024);

          if (sizeMB > 25) {
            fs.unlinkSync(result.filePath);
            continue;
          }

          downloaded = { filePath: result.filePath, title: result.title || video.title, sizeMB };
          chosenVideo = video;
          break;
        } catch (_) { continue; }
      }

      unsendWaiting();

      if (!downloaded || !chosenVideo) {
        return message.reply(❌ تعذر تنزيل الفيديو، جرب كلمات بحث مختلفة.);
      }

      const body =
        ╭━━━━━━━━━━━━━━━━━╮\n +
        🎬 ⌯WHITE 𝗩𝗶𝗱𝗲𝗼\n\n` +
        ╰━━━━━━━━━━━━━━━━━╯\n\n +
       📌 ${downloaded.title}\n` +
       📺 القناة: ${chosenVideo.author.name}\n` +
        ⏱ المدة: ${chosenVideo.timestamp}\n +
       👁 المشاهدات: ${formatViews(chosenVideo.views)}\n` +
       📦 الحجم: ${downloaded.sizeMB.toFixed(2)} MB\n` +
       🔗 https://youtu.be/${chosenVideo.videoId}\n` +
        \n✎﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏﹏\n
↞ ⌯WHITE ˖ ⪼`;

      const durationSec = chosenVideo.seconds || 0;
      const deleteAfterMs = (durationSec + 120) * 1000;

      message.reply({ body, attachment: fs.createReadStream(downloaded.filePath) }, (err, info) => {
        try { fs.unlinkSync(downloaded.filePath); } catch (_) {}
        if (info?.messageID) {
          setTimeout(() => {
            api.unsendMessage(info.messageID).catch(() => {});
          }, deleteAfterMs);
        }
      });

    } catch (err) {
      console.error("[فيديو]", err.message);
      unsendWaiting();
      message.reply("❌ حدث خطأ أثناء البحث أو التحميل، جرب مرة أخرى.");
    }
  }
};
