const functions = require("firebase-functions");
const admin = require("firebase-admin");

// アプリケーションの初期化を一度だけ行います
if (admin.apps.length === 0) {
  admin.initializeApp();
}

// --- 各機能のファイルを読み込み ---
const weeklyPlanner = require('./weeklyPlanner');
const dayPlanner = require('./dayPlanner'); // dayPlanner.jsも読み込む
const testNotificationHandler = require('./sendTestNotification'); // sendTestNotification.jsを読み込む

// =================================================================
// Cloud Functionsとしてデプロイする関数をエクスポート
// =================================================================

// --- 週次プランナー (weeklyPlanner.js) ---
// 既存のURLトリガー関数
exports.runWeeklyPlansManually = weeklyPlanner.runWeeklyPlansManually;
// 新しいアプリ呼び出し用関数
exports.generatePlansOnCall = weeklyPlanner.generatePlansOnCall;


// --- 日次プランナー (dayPlanner.js) ---
// (dayPlanner.jsに関数がある場合、ここに追加します。例:)
exports.planDayFromUrl = dayPlanner.planDayFromUrl;


// --- 通知機能 ---
// テスト通知送信用の関数
exports.sendTestNotification = testNotificationHandler.sendTestNotification;

// (もしagentMode.jsというファイルと、その中のagentNotificationTrigger関数が存在する場合は、以下のコメントを外してください)
// const agentMode = require('./agentMode');
// exports.agentNotificationTrigger = agentMode.agentNotificationTrigger;
