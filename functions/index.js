/**
 * =================================================================
 * メインファイル (index.js) - Agentモード対応
 * =================================================================
 * - 新しく作成した agentMode.js を読み込み、
 * agentNotificationTrigger 関数をエクスポートします。
 */

const admin = require("firebase-admin");

if (admin.apps.length === 0) {
  admin.initializeApp();
}

// --- 各機能の読み込み ---
const weeklyPlanner = require('./weeklyPlanner');
const agentMode = require('./agentMode');

// --- Cloud Functionsとしてデプロイする関数をエクスポート ---

// weeklyPlannerの関数
exports.runWeeklyPlansManually = weeklyPlanner.runWeeklyPlansManually;

// Agentモードの関数
exports.agentNotificationTrigger = agentMode.agentNotificationTrigger;
exports.sendTestNotification = agentMode.sendTestNotification; // ▼▼▼【追加】▼▼▼
// index.js の末尾に追加
exports.sendTestNotification = require('./sendTestNotification').sendTestNotification;