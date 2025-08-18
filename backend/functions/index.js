/**
 * =================================================================
 * index.js - 全てのCloud Functionsの司令塔 (最終修正版)
 * =================================================================
 * - 役割1: Firebase Admin SDKを最初に一度だけ初期化
 * - 役割2: 各ファイルの関数を集約してエクスポート
 */

const admin = require("firebase-admin");
admin.initializeApp();

// 各機能モジュールを読み込み
const weeklyPlanner = require("./weeklyPlanner");
const dayPlanner = require("./dayPlanner");
const testNotificationHandler = require("./sendTestNotification");

// Weekly Planner
exports.runWeeklyPlansManually = weeklyPlanner.runWeeklyPlansManually;
exports.generatePlansOnCall   = weeklyPlanner.generatePlansOnCall;
exports.previewWeeklyPlans    = weeklyPlanner.previewWeeklyPlans;
exports.getPlanStatus         = weeklyPlanner.getPlanStatus;

// Day Planner
exports.runDayPlannerManually = dayPlanner.runDayPlannerManually;
exports.planDayFromUrl        = dayPlanner.planDayFromUrl;

// Notifications
exports.sendTestNotification  = testNotificationHandler.sendTestNotification;