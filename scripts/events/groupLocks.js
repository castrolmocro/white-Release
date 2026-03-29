module.exports = {
  config: {
    name: "groupLocks",
    version: "2.0",
    author: "GoatBot",
    description: "يراقب تغييرات اسم المجموعة والكنيات ويُعيدها أو يحفظها حسب صلاحية المُغيِّر",
    category: "events"
  },

  onStart: async ({ api, event, threadsData }) => {
    const watchedTypes = ["log:thread-name", "log:user-nickname"];
    if (!watchedTypes.includes(event.logMessageType)) return;

    const { threadID, logMessageType, logMessageData, senderID } = event;
    const botID = String(global.GoatBot?.botID || "");
    const sender = String(senderID || "");

    // تجاهل إذا كان البوت نفسه هو من قام بالتغيير (لتجنب الحلقة اللانهائية)
    if (sender === botID) return;

    let tData, locks;
    try {
      tData = await threadsData.get(threadID);
      locks = tData?.groupLocks || {};
    } catch (_) { return; }

    // هل المُغيِّر أدمن في المجموعة؟
    const adminIDs = (tData?.adminIDs || []).map(a => String(a.id || a));
    const senderIsAdmin = adminIDs.includes(sender);

    // ════════════════════════════════════════
    // ── قفل اسم المجموعة ──
    // ════════════════════════════════════════
    if (logMessageType === "log:thread-name" && locks.lockName) {
      const newName = logMessageData?.name || "";

      if (senderIsAdmin) {
        // الأدمن غيّر الاسم → احفظه كاسم محمي جديد
        if (newName !== locks.lockedName) {
          locks.lockedName = newName;
          try {
            await threadsData.set(threadID, locks, "groupLocks");
            await api.sendMessage(
              `✅ تم تحديث الاسم المحمي إلى:\n"${newName}"\nأي شخص آخر يغيّره سيُعاد تلقائياً.`,
              threadID
            );
          } catch (_) {}
        }
      } else {
        // عضو عادي غيّر الاسم → أعِده للاسم المحمي
        const savedName = locks.lockedName;
        if (!savedName || newName === savedName) return;

        setTimeout(async () => {
          try {
            await api.setTitle(savedName, threadID);
            await api.sendMessage(
              `🔒 تم إعادة اسم المجموعة تلقائياً.\nالاسم محمي ولا يمكن تغييره.\nللتعديل استخدم: groupinfo setname`,
              threadID
            );
          } catch (_) {}
        }, 1500);
      }
    }

    // ════════════════════════════════════════
    // ── قفل الكنيات ──
    // ════════════════════════════════════════
    if (logMessageType === "log:user-nickname" && locks.lockNick) {
      const { participant_id, nickname } = logMessageData || {};
      if (!participant_id) return;

      const newNick = nickname || "";
      if (!locks.protectedNicks) locks.protectedNicks = {};
      const savedNick = locks.protectedNicks[participant_id] ?? "";

      if (senderIsAdmin) {
        // الأدمن غيّر الكنية → احفظها كـ"كنية محمية" لهذا العضو
        if (newNick !== savedNick) {
          locks.protectedNicks[participant_id] = newNick;
          try {
            await threadsData.set(threadID, locks, "groupLocks");
            const msg = newNick
              ? `✅ تم حفظ كنية العضو كـ"محمية":\n"${newNick}"\nأي تغيير من عضو آخر سيُعاد تلقائياً.`
              : `✅ تم مسح الكنية المحمية لهذا العضو.\nكنيته ستبقى فارغة وتُعاد إذا غيّرها.`;
            await api.sendMessage(msg, threadID);
          } catch (_) {}
        }
      } else {
        // عضو عادي غيّر كنيته → أعِدها للقيمة المحمية
        if (newNick === savedNick) return;

        setTimeout(async () => {
          try {
            await api.changeNickname(savedNick, threadID, participant_id);
            const msg = savedNick
              ? `🔒 تم إعادة الكنية المحمية تلقائياً:\n"${savedNick}"`
              : `🔒 تم حذف الكنية تلقائياً.\nالكنيات مقفلة في هذه المجموعة.`;
            await api.sendMessage(msg, threadID);
          } catch (_) {}
        }, 1500);
      }
    }
  }
};
