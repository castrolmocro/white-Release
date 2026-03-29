const fs = require("fs");
const path = require("path");
const axios = require("axios");

function formatAge(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days} يوم، ${hours} ساعة`;
  if (hours > 0) return `${hours} ساعة، ${minutes} دقيقة`;
  return `${minutes} دقيقة`;
}

function formatDate(ts) {
  if (!ts) return "غير معروف";
  const d = new Date(Number(ts));
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function getLocks(threadsData, tid) {
  try {
    const tData = await threadsData.get(tid);
    return tData.groupLocks || {};
  } catch (_) { return {}; }
}

async function saveLocks(threadsData, tid, locks) {
  await threadsData.set(tid, locks, "groupLocks");
}

function isBotAdmin(info) {
  const botID = global.GoatBot?.botID;
  if (!botID) return false;
  return (info.adminIDs || []).some(a => String(a.id || a) === String(botID));
}

module.exports = {
  config: {
    name: "boxinfo",
    aliases: ["groupinfo", "ginfo"],
    version: "4.0",
    author: "GoatBot",
    role: 0,
    shortDescription: "معلومات المجموعة وإدارة الأقفال",
    description: {
      en: "Shows group info and allows admins to manage group locks when bot is admin",
      ar: "يعرض معلومات المجموعة ويتيح للإداريين إدارة أقفال المجموعة عندما يكون البوت أدمن"
    },
    category: "box chat",
    guide: {
      en: "{pn} — عرض المعلومات\n"
        + "{pn} lockname — قفل اسم المجموعة\n"
        + "{pn} unlockname — فتح قفل الاسم\n"
        + "{pn} locknick — قفل الكنيات\n"
        + "{pn} unlocknick — فتح قفل الكنيات\n"
        + "{pn} setname <الاسم> — تغيير اسم المجموعة\n"
        + "{pn} status — حالة الأقفال الحالية"
    }
  },

  onStart: async function ({ api, event, threadsData, role, args }) {
    const tid = event.threadID;
    const mid = event.messageID;
    const sub = (args[0] || "").toLowerCase();

    // ── عرض المعلومات (بدون أوامر فرعية) ──
    if (!sub) {
      let info;
      try { info = await api.getThreadInfo(tid); }
      catch (e) { return api.sendMessage("❌ فشل في جلب معلومات المجموعة.", tid, mid); }

      const totalMembers = (info.participantIDs || []).length;
      let male = 0, female = 0, unknownGender = 0;
      for (const u of (info.userInfo || [])) {
        if (u.gender === "MALE") male++;
        else if (u.gender === "FEMALE") female++;
        else unknownGender++;
      }

      const adminCount = (info.adminIDs || []).length;
      const botAdmin = isBotAdmin(info) ? "✅ أدمن" : "❌ ليس أدمن";
      const locks = await getLocks(threadsData, tid);

      let joinedDate = "غير معروف", groupAge = "غير معروف";
      try {
        const tData = await threadsData.get(tid);
        if (tData?.createdAt) {
          joinedDate = formatDate(tData.createdAt);
          groupAge = formatAge(Date.now() - Number(tData.createdAt));
        }
      } catch (_) {}

      const groupName = info.threadName || "بدون اسم";
      const emoji     = info.emoji || "لا يوجد";
      const approval  = info.approvalMode ? "✅ مفعّل" : "❌ مُعطَّل";
      const msgCount  = info.messageCount != null ? info.messageCount.toLocaleString() : "غير معروف";
      const color     = info.color
        ? `#${Number(info.color).toString(16).padStart(6, "0").toUpperCase()}`
        : "افتراضي";

      const lockNameStatus = locks.lockName ? "🔒 مقفل" : "🔓 مفتوح";
      const lockNickStatus = locks.lockNick ? "🔒 مقفل" : "🔓 مفتوح";

      const text =
`╔══════════════════════╗
       📋 معلومات المجموعة
╠══════════════════════╣
📌 الاسم       : ${groupName}
🆔 الـ ID      : ${tid}
╠══════════════════════╣
👥 الأعضاء     : ${totalMembers}
👑 الإداريون   : ${adminCount}
🧑 ذكور        : ${male}
👩 إناث        : ${female}
❓ غير محدد    : ${unknownGender}
╠══════════════════════╣
💬 الرسائل     : ${msgCount}
🔐 موافقة      : ${approval}
😀 إيموجي      : ${emoji}
🎨 اللون       : ${color}
╠══════════════════════╣
🤖 البوت       : ${botAdmin}
🏷️ قفل الاسم  : ${lockNameStatus}
✏️ قفل الكنية : ${lockNickStatus}
╠══════════════════════╣
📅 انضمام البوت : ${joinedDate}
⏳ المدة        : ${groupAge}
╚══════════════════════╝`;

      if (info.imageSrc) {
        const cacheDir = path.join(__dirname, "cache");
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const imgPath = path.join(cacheDir, `groupinfo_${tid}.jpg`);
        try {
          const res = await axios.get(encodeURI(info.imageSrc), { responseType: "arraybuffer", timeout: 10000 });
          fs.writeFileSync(imgPath, res.data);
          return api.sendMessage(
            { body: text, attachment: fs.createReadStream(imgPath) },
            tid,
            () => { try { fs.unlinkSync(imgPath); } catch (_) {} },
            mid
          );
        } catch (_) {}
      }
      return api.sendMessage(text, tid, mid);
    }

    // ── الأوامر الإدارية تتطلب role >= 1 ──
    if (role < 1) {
      return api.sendMessage("⛔ هذا الأمر مخصص للإداريين فقط.", tid, mid);
    }

    // ── تغيير اسم المجموعة ──
    if (sub === "setname") {
      const newName = args.slice(1).join(" ").trim();
      if (!newName) return api.sendMessage("❌ اكتب الاسم الجديد بعد الأمر.\nمثال: groupinfo setname اسم جديد", tid, mid);
      let info;
      try { info = await api.getThreadInfo(tid); } catch (e) { return api.sendMessage("❌ فشل في جلب معلومات المجموعة.", tid, mid); }
      if (!isBotAdmin(info)) return api.sendMessage("⚠️ البوت ليس أدمناً في هذه المجموعة.\nأعطه صلاحية الأدمن أولاً.", tid, mid);
      try {
        await api.setTitle(newName, tid);
        const locks = await getLocks(threadsData, tid);
        if (locks.lockName) {
          locks.lockedName = newName;
          await saveLocks(threadsData, tid, locks);
        }
        return api.sendMessage(`✅ تم تغيير اسم المجموعة إلى:\n"${newName}"`, tid, mid);
      } catch (e) {
        return api.sendMessage("❌ فشل في تغيير الاسم: " + (e.error || e.message || e), tid, mid);
      }
    }

    // ── قفل اسم المجموعة ──
    if (sub === "lockname") {
      let info;
      try { info = await api.getThreadInfo(tid); } catch (e) { return api.sendMessage("❌ فشل في جلب معلومات المجموعة.", tid, mid); }
      if (!isBotAdmin(info)) return api.sendMessage("⚠️ البوت ليس أدمناً في هذه المجموعة.\nأعطه صلاحية الأدمن أولاً.", tid, mid);
      const locks = await getLocks(threadsData, tid);
      locks.lockName = true;
      locks.lockedName = info.threadName || "";
      await saveLocks(threadsData, tid, locks);
      return api.sendMessage(
        `🔒 تم قفل اسم المجموعة.\n`
        + `أي شخص يحاول تغيير الاسم سيُعاد تلقائياً إلى:\n"${locks.lockedName}"`,
        tid, mid
      );
    }

    // ── فتح قفل اسم المجموعة ──
    if (sub === "unlockname") {
      const locks = await getLocks(threadsData, tid);
      locks.lockName = false;
      locks.lockedName = null;
      await saveLocks(threadsData, tid, locks);
      return api.sendMessage("🔓 تم فتح قفل اسم المجموعة.\nيمكن للجميع تغيير الاسم الآن.", tid, mid);
    }

    // ── قفل الكنيات ──
    if (sub === "locknick") {
      let info;
      try { info = await api.getThreadInfo(tid); } catch (e) { return api.sendMessage("❌ فشل في جلب معلومات المجموعة.", tid, mid); }
      if (!isBotAdmin(info)) return api.sendMessage("⚠️ البوت ليس أدمناً في هذه المجموعة.\nأعطه صلاحية الأدمن أولاً.", tid, mid);
      const locks = await getLocks(threadsData, tid);
      locks.lockNick = true;

      // لقطة للكنيات الحالية → تصبح هي الكنيات المحمية عند التفعيل
      if (!locks.protectedNicks) locks.protectedNicks = {};
      const nicknames = info.nicknames || {};
      for (const [uid, nick] of Object.entries(nicknames)) {
        if (!(uid in locks.protectedNicks)) {
          locks.protectedNicks[uid] = nick || "";
        }
      }

      await saveLocks(threadsData, tid, locks);
      const savedCount = Object.values(locks.protectedNicks).filter(n => n).length;
      return api.sendMessage(
        `🔒 تم قفل الكنيات.\n`
        + `📸 تم حفظ ${savedCount} كنية حالية كـ"محمية".\n`
        + `• أدمن يغيّر كنية عضو → تُحفظ الجديدة وتُطبَّق.\n`
        + `• أي عضو آخر يغيّر كنيته → تُعاد الكنية المحمية تلقائياً.`,
        tid, mid
      );
    }

    // ── فتح قفل الكنيات ──
    if (sub === "unlocknick") {
      const locks = await getLocks(threadsData, tid);
      locks.lockNick = false;
      locks.protectedNicks = {};
      await saveLocks(threadsData, tid, locks);
      return api.sendMessage("🔓 تم فتح قفل الكنيات.\nيمكن للجميع تغيير كنيتهم الآن.\nتم مسح جميع الكنيات المحمية.", tid, mid);
    }

    // ── حالة الأقفال ──
    if (sub === "status") {
      let info;
      try { info = await api.getThreadInfo(tid); } catch (_) { info = {}; }
      const locks = await getLocks(threadsData, tid);
      const botAdmin = isBotAdmin(info) ? "✅ أدمن" : "❌ ليس أدمن";
      return api.sendMessage(
`📊 حالة الأقفال في هذه المجموعة:
━━━━━━━━━━━━━━━━━━━━
🤖 البوت         : ${botAdmin}
🏷️ قفل الاسم    : ${locks.lockName ? `🔒 مقفل\n   ↩️ الاسم المحفوظ: "${locks.lockedName}"` : "🔓 مفتوح"}
✏️ قفل الكنيات  : ${locks.lockNick ? "🔒 مقفل" : "🔓 مفتوح"}
━━━━━━━━━━━━━━━━━━━━
الأوامر المتاحة:
• groupinfo lockname / unlockname
• groupinfo locknick / unlocknick
• groupinfo setname <الاسم>`,
        tid, mid
      );
    }

    return api.sendMessage(
      "❓ أمر غير معروف. الأوامر المتاحة:\n"
      + "• groupinfo — عرض المعلومات\n"
      + "• groupinfo lockname / unlockname\n"
      + "• groupinfo locknick / unlocknick\n"
      + "• groupinfo setname <الاسم>\n"
      + "• groupinfo status",
      tid, mid
    );
  }
};
