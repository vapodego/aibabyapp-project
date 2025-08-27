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

exports.generateMonthlyArticles = https.onRequest({ timeoutSeconds: 540, secrets: [GEMINI_API_KEY] }, withCors(async (req, res) => {
  // TODO: Geminiで本文生成 → articles に保存
  res.status(200).json({ ok: true, message: 'generateMonthlyArticles stub' });
}));

exports.deliverDailyFeeds = https.onRequest({ timeoutSeconds: 540 }, withCors(async (req, res) => {
  // TODO: ユーザーごとに記事選定 → users/{uid}/articleFeeds に upsert
  res.status(200).json({ ok: true, message: 'deliverDailyFeeds stub' });
}));

// --- 他のモジュール (DayPlanner, Notifications) は安定後に復帰予定 ---

// ---------------------------------------------------------------
// askArticleQuestion (Callable): 専用モジュールへ委譲（保存まで実行）
// ---------------------------------------------------------------
exports.askArticleQuestion = require('./qa/askArticleQuestion').askArticleQuestion;