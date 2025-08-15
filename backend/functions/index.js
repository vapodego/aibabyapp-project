/**
 * =================================================================
 * Cloud Functions エントリポイント (index.js)
 * =================================================================
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

// アプリケーションの初期化を一度だけ実行
if (admin.apps.length === 0) {
  admin.initializeApp();
}

// --- Day Planner ---
// ファイル分割に対応し、dayPlanner.jsから関数を読み込む
const dayPlanner = require("./dayPlanner");
exports.runDayPlannerManually = dayPlanner.runDayPlannerManually;
exports.planDayFromUrl = dayPlanner.planDayFromUrl;


// --- 既存の他機能 (変更なし) ---
const weeklyPlanner = require("./weeklyPlanner");
const testNotificationHandler = require("./sendTestNotification");

// 週次プランナー
exports.runWeeklyPlansManually   = weeklyPlanner.runWeeklyPlansManually;
exports.runWeeklyPlansV2Manually = require("./WeeklyPlanner_v2").runWeeklyPlansV2Manually;
exports.runWeeklyPlansA1Manually = require("./weeklyPlanner_a1").runWeeklyPlansA1Manually;
exports.runWeeklyPlansA2Manually = require("./weeklyPlanner_a2").runWeeklyPlansA2Manually;

// 非同期ジョブ
exports.weeklyPlansJob     = require("./weeklyPlanner_async").weeklyPlansJob;
exports.onPlannerJobCreate = require("./weeklyPlanner_async").onPlannerJobCreate;

// アプリからの呼び出し
exports.generatePlansOnCall = weeklyPlanner.generatePlansOnCall;

// 通知
exports.sendTestNotification = testNotificationHandler.sendTestNotification;

// agentMode がある場合は必要に応じて有効化
// const agentMode = require('./agentMode');
// exports.agentNotificationTrigger = agentMode.agentNotificationTrigger;
