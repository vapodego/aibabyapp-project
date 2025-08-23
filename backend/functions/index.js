const { setGlobalOptions, https } = require("firebase-functions/v2");
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

// --- 他のモジュール (DayPlanner, Notifications) は安定後に復帰予定 ---