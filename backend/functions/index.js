const { setGlobalOptions, https } = require("firebase-functions/v2");
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require("firebase-functions/params");

setGlobalOptions({
  region: "asia-northeast1",
  memory: "512MiB",
  timeoutSeconds: 120,
});

const admin = require("firebase-admin");
try {
  admin.app();
} catch {
  admin.initializeApp();
}

const { ensureArticleHeroImage } = require('./utils/imagegen');

// ---------------------------------------------------------------
// Shared helper to create dummy articles and images
// ---------------------------------------------------------------
// 置き換え：関数本体を丸ごと差し替え
async function generateArticlesCore() {
   const now = admin.firestore.Timestamp.now();
   const seeds = [
     { title: '生後5か月：うつ伏せ遊びで育つ力', body: '…', monthAge: 5, tags: ['発達','遊び','安全'], version: 1 },
     { title: '生後6か月：離乳食の始め方',       body: '…', monthAge: 6, tags: ['離乳食','栄養'],     version: 1 },
     { title: '生後7か月：寝かしつけのコツ',     body: '…', monthAge: 7, tags: ['睡眠','生活リズム'], version: 1 },
   ];
   const pick = seeds[Math.floor(Date.now() / 60000) % seeds.length];
   const ref = db.collection('articles').doc();
   await ref.set({ ...pick, createdAt: now, updatedAt: now });
   try {
     const image = await ensureArticleHeroImage(ref.id, pick);
     await ref.update({ image, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
   } catch (e) {
     console.warn('[generateMonthlyArticles] imagegen failed:', e?.message || e);
   }
   return ref.id;
 }

// ---------------------------------------------------------------
// Secrets (for Google Custom Search etc.)
// ---------------------------------------------------------------
const GOOGLE_API_KEY = defineSecret("GOOGLE_API_KEY");
const GOOGLE_CSE_ID = defineSecret("GOOGLE_CSE_ID");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// Expose callable endpoint (v2) defined in weeklyPlanner.js
const weeklyPlanner = require("./weeklyPlanner");
exports.generatePlansOnCall = weeklyPlanner.generatePlansOnCall;
exports.generatePlansOnRequest = weeklyPlanner.generatePlansOnRequest;

// ---------------------------------------------------------------
// CORS ユーティリティ
// ---------------------------------------------------------------
const ALLOWED_ORIGINS = ["*"]; // 必要なら特定のオリジンに絞る
const DEFAULT_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Max-Age": "3600",
  "X-App-Version": "functions-v2-bridge-2025-08-19",
};

function withCors(handler) {
  return async (req, res) => {
    // CORS headers
    Object.entries(DEFAULT_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === "OPTIONS") {
      // Preflight
      return res.status(204).send("");
    }

    try {
      await handler(req, res);
    } catch (err) {
      console.error("[withCors] Uncaught error:", err && err.stack ? err.stack : err);
      try {
        res.status(500).send("Internal Server Error");
      } catch (_) {
        // ignore double send
      }
    }
  };
}

// ---------------------------------------------------------------
// Health check
// ---------------------------------------------------------------
exports.ping = https.onRequest({ timeoutSeconds: 30 }, withCors(async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).send("Method Not Allowed");
  }
  res.status(200).send("pong");
}));

// ---------------------------------------------------------------
// WeeklyPlanner bridges
// ---------------------------------------------------------------
exports.runWeeklyPlansManually = https.onRequest({
  timeoutSeconds: 3600,
  secrets: [GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_CSE_ID],
}, withCors(async (req, res) => {
  console.log('[diag] env.GEMINI_API_KEY exists?', !!process.env.GEMINI_API_KEY);
  console.log('[diag] env.GOOGLE_API_KEY exists?', !!process.env.GOOGLE_API_KEY);
  console.log('[diag] env.GOOGLE_CSE_ID exists?', !!process.env.GOOGLE_CSE_ID || !!process.env.GOOGLE_CX);
  const weeklyPlanner = require("./weeklyPlanner");
  if (typeof weeklyPlanner.runWeeklyPlansManually !== "function") {
    console.error("[Bridge] weeklyPlanner.runWeeklyPlansManually not found");
    return res.status(500).send("Internal Server Error (bridge missing)");
  }
  return weeklyPlanner.runWeeklyPlansManually(req, res);
}));

exports.previewWeeklyPlans = https.onRequest({
  timeoutSeconds: 120,
  secrets: [GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_CSE_ID],
}, withCors(async (req, res) => {
  const weeklyPlanner = require("./weeklyPlanner");
  if (typeof weeklyPlanner.previewWeeklyPlans !== "function") {
    console.error("[Bridge] weeklyPlanner.previewWeeklyPlans not found");
    return res.status(500).send("Internal Server Error (bridge missing)");
  }
  return weeklyPlanner.previewWeeklyPlans(req, res);
}));

exports.getPlanStatus = https.onRequest({
  timeoutSeconds: 120,
  secrets: [GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_CSE_ID],
}, withCors(async (req, res) => {
  const weeklyPlanner = require("./weeklyPlanner");
  if (typeof weeklyPlanner.getPlanStatus !== "function") {
    console.error("[Bridge] weeklyPlanner.getPlanStatus not found");
    return res.status(500).send("Internal Server Error (bridge missing)");
  }
  return weeklyPlanner.getPlanStatus(req, res);
}));

// ---------------------------------------------------------------
// Articles: seed & stubs (Phase 1 groundwork)
// ---------------------------------------------------------------
const db = admin.firestore();

// ---------------------------------------------------------------
// Helper: Generate article title+body with Gemini (always used for creation)
// ---------------------------------------------------------------
async function generateArticleWithGemini({ topic, monthAge, tags }) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    // Switch to Pro for denser, longer outputs
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

    const tagText = Array.isArray(tags) ? tags.join(', ') : '';
    const audience = Number.isFinite(monthAge) ? `対象: 生後${monthAge}か月` : '対象: 乳幼児保護者一般';
    const prompt = [
      'あなたは小児保健の監修方針に沿って記事を作る編集者です。',
      '次の利用者要望（トピック）をもとに、日本語で濃い内容の記事を作成します。',
      '出力は必ず次のJSONスキーマに厳密に従ってください。説明文や余計な文字は一切出力しないでください。',
      '',
      '{',
      '  "title": "40文字以内の具体的なタイトル",',
      '  "sections": [',
      '    "第1セクション（350〜550文字、導入・背景・全体像。絵文字は自然な範囲で自由に）",',
      '    "第2セクション（350〜550文字、実例3つ・やってはいけないこと3つのいずれかを含む。絵文字は任意）",',
      '    "第3セクション（350〜550文字、家庭での実践手順・注意点。絵文字は任意）",',
      '    "第4セクション（350〜550文字、受診の目安：具体条件を列挙。絵文字は任意）"',
      '  ],',
      '  "tags": ["短い名詞3〜5個"],',
      '  "sources": [',
      '    {"title": "参考資料名", "url": "https://...", "note": "根拠や要点（1文）"}',
      '  ]',
      '}',
      '',
      '制約:',
      '- 事実ベースで安全第一。医療判断はしない。',
      '- 箇条書き記号やMarkdownは使わず、プレーンテキストの段落で。',
      '- 絵文字は自然な文脈で使っても使わなくてもよい。目安は記事全体で0〜3個程度（不要なら0でOK）。種類は中立的なものに限定（例: 🌟💡🍀🍼⚠️🏥💤🙂🍚🛌）。',
      '- 日本の保護者向けの語調。断定は避け丁寧に。',
      '',
      `トピック: ${topic}`,
      audience,
      tagText ? `参考タグ: ${tagText}` : '',
    ].filter(Boolean).join('\n');

    const res = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.55,
        topP: 0.9,
        maxOutputTokens: 4096,
      },
    });
    let text = '';
    try { text = res.response.text(); } catch (_) {
      const c = res?.response?.candidates?.[0]?.content?.parts || [];
      text = c.map(p => p?.text).filter(Boolean).join('\n');
    }
    const s = String(text || '');
    // Try to parse JSON object in the response
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    // --- Emoji soft sanitizer (no placement rules): keep to a small global cap and whitelist ---
    const sanitizeEmojis = (str) => {
      try {
        const allowed = ['🌟','💡','🍀','🍼','⚠️','🏥','💤','🙂','🍚','🛌'];
        const MAX = 3;
        let out = String(str || '');
        // Remove most pictographs outside our allowlist (broad ranges)
        out = out.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}]/gu, (m) => (allowed.includes(m) ? m : ''));
        // Enforce global cap across allowed set (scan left-to-right)
        let count = 0;
        for (const emo of allowed) {
          out = out.replace(new RegExp(emo.replace(/([.*+?^${}()|[\]\\])/g, '\\$1'), 'g'), (m) => {
            if (count < MAX) { count++; return m; }
            return '';
          });
        }
        // Collapse accidental repeats (e.g., "🌟🌟" -> "🌟")
        out = out.replace(/(🌟|💡|🍀|🍼|⚠️|🏥|💤|🙂|🍚|🛌){2,}/g, '$1');
        return out;
      } catch (_) { return String(str || ''); }
    };

    if (start >= 0 && end > start) {
      try {
        const obj = JSON.parse(s.slice(start, end + 1));
        const title = sanitizeEmojis(String(obj.title || '').trim());
        const rawSections = Array.isArray(obj.sections) ? obj.sections.map(v => String(v || '').replace(/\r/g,'').trim()).filter(Boolean) : [];
        const sections = rawSections.map(sct => sanitizeEmojis(sct));
        const body = (sections.length ? sections.join('\n\n') : String(obj.body || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim());
        const bodySan = sanitizeEmojis(body);
        const tagsOut = Array.isArray(obj.tags) ? obj.tags.map(t => String(t).trim()).filter(Boolean).slice(3,8).slice(0,5) : (Array.isArray(obj.tags) ? obj.tags.map(t => String(t).trim()).filter(Boolean).slice(0,5) : []);
        const sourcesOut = Array.isArray(obj.sources)
          ? obj.sources.map(x => ({
              title: String(x?.title || '').trim(),
              url: String(x?.url || '').trim(),
              note: String(x?.note || '').trim(),
            })).filter(x => x.title || x.url)
          : [];
        if (title && bodySan) return { title, body: bodySan, sections, tags: tagsOut, sources: sourcesOut };
      } catch (_) { /* fallthrough */ }
    }
    // Heuristic fallback: first line as title
    const lines = s.split(/\n+/).map(t => t.trim()).filter(Boolean);
    const title = sanitizeEmojis((lines[0] || topic).slice(0, 40));
    const body = sanitizeEmojis(lines.slice(1).join('\n').trim() || `${topic}\n\nこの記事は安全性を重視して概要をまとめています。気になる場合は小児科等にご相談ください。`);
    return { title, body, sections: [], tags: [], sources: [] };
  } catch (e) {
    console.error('[generateArticleWithGemini] generation failed:', e?.message || e);
    throw new Error('article generation failed (Gemini)');
  }
}

// ---------------------------------------------------------------
// requestArticleCreation (Callable): 1本だけ記事を作成（任意ペイロード対応）
// フロントから data = { title?, body?, monthAge?, tags? } を渡せます。
// 省略時はサンプルシードから1件ローテーションで作成。
// ---------------------------------------------------------------
exports.requestArticleCreation = onCall({ region: 'asia-northeast1', timeoutSeconds: 540, invoker: 'public', secrets: [GEMINI_API_KEY] }, async (req, context) => {
  try {
    console.log('[requestArticleCreation] context.auth:', context && context.auth ? { uid: context.auth.uid, tokenKeys: Object.keys(context.auth.token || {}) } : null);
    console.log('[requestArticleCreation] hasAppCheckToken:', !!(context && context.app));
    console.log('[requestArticleCreation] incoming payload keys:', Object.keys((req && req.data) || {}));
    console.log('[requestArticleCreation] GEMINI_API_KEY exists?', !!process.env.GEMINI_API_KEY);
    const now = admin.firestore.Timestamp.now();
    const payload = req?.data || {};

    // シード（省略時のデフォルト素材）
    const seeds = [
      { title: '生後5か月：うつ伏せ遊びで育つ力',
        body: '生後5か月ごろは首や体幹が安定してきます。うつ伏せ遊びでバランス感覚や筋力を養いましょう。安全な環境で短時間から…',
        monthAge: 5, tags: ['発達','遊び','安全'], version: 1 },
      { title: '生後6か月：離乳食の始め方',
        body: '生後6か月前後から離乳食をスタート。最初はなめらかにすりつぶしたペーストを小さじ1から…',
        monthAge: 6, tags: ['離乳食','栄養'], version: 1 },
      { title: '生後7か月：寝かしつけのコツ',
        body: '生活リズムを整え、寝かしつけの合図を作るとスムーズ。明るさや音、温度を整えて…',
        monthAge: 7, tags: ['睡眠','生活リズム'], version: 1 },
    ];

    // Always generate with Gemini based on topic (client sends topic)
    const topic = String(payload.topic || payload.title || seeds[0].title);
    console.log('[requestArticleCreation] generating via Gemini topic.len=', topic.length);
    const gen = await generateArticleWithGemini({ topic, monthAge: undefined, tags: [] });
    console.log('[requestArticleCreation] generated title/body bytes:', { title: (gen.title||'').length, body: (gen.body||'').length, tags: (Array.isArray(gen.tags) ? gen.tags.length : 0) });
    const art = {
      title: gen.title,
      body: gen.body,
      tags: Array.isArray(gen.tags) ? gen.tags : [],
      sections: Array.isArray(gen.sections) && gen.sections.length ? gen.sections : undefined,
      sources: Array.isArray(gen.sources) && gen.sources.length ? gen.sources : undefined,
      version: 1,
      locale: 'ja-JP',
      status: 'published',
    };

    const ref = db.collection('articles').doc();
    console.log('[requestArticleCreation] about to save article', { titleBytes: art.title.length, bodyBytes: art.body.length, tagsCount: art.tags.length });
    await ref.set({ ...art, createdAt: now, updatedAt: now });
    try {
      const saved = await ref.get();
      const b = String(saved.get('body') || '').length;
      console.log('[requestArticleCreation] saved article body bytes:', b);
    } catch (_) {}

    // Feed: create delivered item for the creator (if signed-in)
    try {
      const uid = context?.auth?.uid;
      if (uid) {
        const feedRef = db.doc(`users/${uid}/articleFeeds/${ref.id}`);
        await feedRef.set({
          articleId: ref.id,
          deliveredAt: now,
          updatedAt: now,
          readAt: null,
        }, { merge: true });
      }
    } catch (e) {
      console.warn('[requestArticleCreation] feed creation skipped', e?.message || e);
    }

    // 画像生成は自動では行わない（ユーザー操作で生成）
    return { ok: true, articleId: ref.id, title: art.title };
  } catch (e) {
    console.error('[requestArticleCreation] error', e);
    throw new HttpsError('internal', e?.message || 'failed');
  }
});

// HTTP 公開版（認可エラー回避のフォールバック用）
exports.requestArticleCreationHttp = https.onRequest({ timeoutSeconds: 540, memory: '512MiB', secrets: [GEMINI_API_KEY] }, withCors(async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const now = admin.firestore.Timestamp.now();
    const payload = req?.body || {};
    console.log('[requestArticleCreationHttp] GEMINI_API_KEY exists?', !!process.env.GEMINI_API_KEY);
    const uid = typeof payload.uid === 'string' && payload.uid ? String(payload.uid) : null;

    const seeds = [
      { title: '生後5か月：うつ伏せ遊びで育つ力',
        body: '生後5か月ごろは首や体幹が安定してきます。うつ伏せ遊びでバランス感覚や筋力を養いましょう。安全な環境で短時間から…',
        monthAge: 5, tags: ['発達','遊び','安全'], version: 1 },
      { title: '生後6か月：離乳食の始め方',
        body: '生後6か月前後から離乳食をスタート。最初はなめらかにすりつぶしたペーストを小さじ1から…',
        monthAge: 6, tags: ['離乳食','栄養'], version: 1 },
      { title: '生後7か月：寝かしつけのコツ',
        body: '生活リズムを整え、寝かしつけの合図を作るとスムーズ。明るさや音、温度を整えて…',
        monthAge: 7, tags: ['睡眠','生活リズム'], version: 1 },
    ];

    const topic = String(payload.topic || payload.title || seeds[0].title);
    console.log('[requestArticleCreationHttp] generating via Gemini topic.len=', topic.length);
    const gen = await generateArticleWithGemini({ topic, monthAge: undefined, tags: [] });
    console.log('[requestArticleCreationHttp] generated title/body bytes:', { title: (gen.title||'').length, body: (gen.body||'').length, tags: (Array.isArray(gen.tags) ? gen.tags.length : 0) });
    const art = {
      title: gen.title,
      body: gen.body,
      tags: Array.isArray(gen.tags) ? gen.tags : [],
      sections: Array.isArray(gen.sections) && gen.sections.length ? gen.sections : undefined,
      sources: Array.isArray(gen.sources) && gen.sources.length ? gen.sources : undefined,
      version: 1,
      locale: 'ja-JP',
      status: 'published',
    };

    const ref = db.collection('articles').doc();
    console.log('[requestArticleCreationHttp] about to save article', { titleBytes: art.title.length, bodyBytes: art.body.length, tagsCount: art.tags.length });
    await ref.set({ ...art, createdAt: now, updatedAt: now });
    try {
      const saved = await ref.get();
      const b = String(saved.get('body') || '').length;
      console.log('[requestArticleCreationHttp] saved article body bytes:', b);
    } catch (_) {}
    // if uid is provided, create feed for that user
    if (uid) {
      try {
        await db.doc(`users/${uid}/articleFeeds/${ref.id}`).set({
          articleId: ref.id,
          deliveredAt: now,
          updatedAt: now,
          readAt: null,
        }, { merge: true });
      } catch (e) {
        console.warn('[requestArticleCreationHttp] feed create failed', e?.message || e);
      }
    }

    // 画像生成は自動で行わない
    return res.status(200).json({ ok: true, articleId: ref.id, title: art.title });
  } catch (e) {
    console.error('[requestArticleCreationHttp] error', e);
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
}));

exports.seedArticles = https.onRequest({ timeoutSeconds: 120 }, withCors(async (req, res) => {
  try {
    if (req.method !== 'POST' && req.method !== 'GET') {
      return res.status(405).send('Method Not Allowed');
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const seed = [
      {
        title: '生後6か月：寝返りが増える時期',
        monthAge: 6,
        tags: ['発達'],
        body: 'この月齢では体幹が育ち、寝返りが増えます。安全な環境づくりと見守りが大切です。',
        version: 1,
        locale: 'ja-JP',
        status: 'published',
      },
      {
        title: '生後6か月：離乳食の始め方',
        monthAge: 6,
        tags: ['離乳食'],
        body: '鉄分・たんぱく質を意識しつつ、アレルギーに注意して一品ずつ進めましょう。',
        version: 1,
        locale: 'ja-JP',
        status: 'published',
      },
      {
        title: '生後5か月：うつ伏せ遊びで育つ力',
        monthAge: 5,
        tags: ['発達'],
        body: 'うつ伏せでの手伸ばしやキックは体幹と上肢の発達を促します。短時間から安全に。',
        version: 1,
        locale: 'ja-JP',
        status: 'published',
      },
    ];

    const batch = db.batch();
    seed.forEach((art) => {
      const ref = db.collection('articles').doc();
      batch.set(ref, { ...art, createdAt: now, updatedAt: now });
    });
    await batch.commit();

    res.status(200).json({ ok: true, count: seed.length });
  } catch (e) {
    console.error('[seedArticles] error', e);
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}));

exports.generateMonthlyArticles = onCall({ region: 'asia-northeast1', timeoutSeconds: 540 }, async () => {
  try {
    const created = await generateArticlesCore();
    return { ok: true, createdId: created };   // 単一ID
  } catch (e) {
    console.error('[generateMonthlyArticles:onCall] error', e);
    throw new HttpsError('internal', e?.message || 'failed');
  }
});

exports.generateMonthlyArticlesHttp = https.onRequest({ timeoutSeconds: 540 }, withCors(async (req, res) => {
  try {
    if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).send('Method Not Allowed');
    const created = await generateArticlesCore();
    res.status(200).json({ ok: true, createdId: created }); // 単一ID
  } catch (e) {
    console.error('[generateMonthlyArticles:http] error', e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}));

exports.deliverDailyFeeds = https.onRequest({ timeoutSeconds: 540 }, withCors(async (req, res) => {
  try {
    // Allow GET or POST for convenience
    if (req.method !== 'POST' && req.method !== 'GET') {
      return res.status(405).send('Method Not Allowed');
    }

    const qUid = String(req.query.uid || req.body?.uid || '').trim();
    const limitArticles = Math.max(1, Math.min(10, Number(req.query.limit || req.body?.limit || 3) || 3));
    const monthAge = Number(req.query.monthAge || req.body?.monthAge);

    // Pick recent articles (desc)
    const artSnap = await db
      .collection('articles')
      .orderBy('createdAt', 'desc')
      .limit(limitArticles)
      .get();
    const articles = artSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (articles.length === 0) {
      return res.status(200).json({ ok: true, delivered: 0, reason: 'no-articles' });
    }

    const deliverToUser = async (uid) => {
      if (!uid) return { uid, delivered: 0 };
      const batch = db.batch();
      let delivered = 0;
      // Optional: basic filter by monthAge ±1 if provided
      const filtered = Number.isFinite(monthAge)
        ? articles.filter(a => {
            const m = Number(a?.monthAge);
            return Number.isFinite(m) ? Math.abs(m - monthAge) <= 1 : true;
          })
        : articles;
      for (const a of filtered) {
        const ref = db.doc(`users/${uid}/articleFeeds/${a.id}`);
        const snap = await ref.get();
        if (snap.exists) {
          const cur = snap.data() || {};
          const patch = {
            articleId: a.id,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (typeof cur.readAt === 'undefined') patch.readAt = null; // backfill for unread
          batch.set(ref, patch, { merge: true });
        } else {
          batch.set(ref, {
            articleId: a.id,
            deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            readAt: null,
          }, { merge: true });
          delivered += 1;
        }
      }
      await batch.commit();
      return { uid, delivered };
    };

    const results = [];
    if (qUid) {
      results.push(await deliverToUser(qUid));
    } else {
      // Deliver to all users (capped to 100 to avoid long runs during dev)
      const usersSnap = await db.collection('users').limit(100).get();
      for (const u of usersSnap.docs) {
        const uid = u.id;
        results.push(await deliverToUser(uid));
      }
    }

    const total = results.reduce((s, r) => s + (r?.delivered || 0), 0);
    return res.status(200).json({ ok: true, totalDelivered: total, results });
  } catch (e) {
    console.error('[deliverDailyFeeds] error', e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}));

// --- 他のモジュール (DayPlanner, Notifications) は安定後に復帰予定 ---

// ---------------------------------------------------------------
// askArticleQuestion (Callable): 専用モジュールへ委譲（保存まで実行）
// ---------------------------------------------------------------
exports.askArticleQuestion = require('./qa/askArticleQuestion').askArticleQuestion;

// ---------------------------------------------------------------
// ensureArticleImage: 記事ごとのヒーロー画像生成 → Storage保存 → Firestore patch
// ---------------------------------------------------------------
exports.ensureArticleImage = https.onRequest(
  { timeoutSeconds: 300, memory: '1GiB' },
  withCors(async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).send('POST only');
      const force = String(req.query.force || '') === '1';
      const { articleId } = req.body || {};
      if (!articleId) {
        return res.status(400).json({ ok: false, error: 'articleId is required' });
      }

      const ref = db.collection('articles').doc(articleId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ ok: false, error: 'article not found' });
      }
      const art = snap.data() || {};

      // 冪等: すでに image があればスキップ（?force=1 で再生成）
      if (!force && art.image && art.image.url) {
        return res.status(200).json({ ok: true, skipped: true, image: art.image });
      }

      const imageMeta = await ensureArticleHeroImage(articleId, art);
      await ref.set(
        {
          image: imageMeta,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.status(200).json({ ok: true, image: imageMeta });
    } catch (e) {
      console.error('[ensureArticleImage] error', e);
      return res
        .status(500)
        .json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  })
);
