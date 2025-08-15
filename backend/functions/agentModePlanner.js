/**
 * =================================================================
 * AgentMode v2.3: 超詳細プランナー (agentModePlanner.js) - リファクタリング対応版
 * =================================================================
 * - 担当: Gemini
 * - 修正点: 循環参照の警告を解消するため、HTMLレポート生成関数の読み込み元を
 * `api-tools.js` から、新しく作成した `report-generator.js` に変更しました。
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

const { agentNavigationPlanning } = require('./agents/navigation');
// ★★★ 修正点: 読み込み元を変更 ★★★
const { createComprehensiveHtmlReport } = require('./utils/report-generator');

exports.generateSuperDetailedPlan = functions
  .region("asia-northeast1")
  .https.onCall(async (data, context) => {
    console.log('[DEBUG] generateSuperDetailedPlan: 関数が呼び出されました。');

    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'この機能を利用するには認証が必要です。');
    }

    const userId = context.auth.uid || "test-user-id";
    const { basePlan, originAddress } = data;

    if (!basePlan || !basePlan.location || !basePlan.location.address) {
      throw new functions.https.HttpsError('invalid-argument', 'プラン情報が不完全です。');
    }

    try {
      let startAddress;
      if (originAddress) {
        startAddress = originAddress;
        console.log(`[AgentMode Planner] パラメータで指定された出発地を使用します: ${startAddress}`);
      } else {
        const userDoc = await admin.firestore().collection('users').doc(userId).get();
        startAddress = (userDoc.exists && userDoc.data()?.homeAddress) ? userDoc.data().homeAddress : "東京都新宿区";
        console.log(`[AgentMode Planner] Firestoreの保存先またはデフォルトの出発地を使用します: ${startAddress}`);
      }
      
      console.log(`[AgentMode Planner] User: ${userId}, Plan: ${basePlan.eventName}, Origin: ${startAddress} の詳細プラン生成を開始します。`);

      console.log('[DEBUG] generateSuperDetailedPlan: ナビゲーションエージェントを呼び出し、全情報を収集します...');
      const comprehensiveNavigationData = await agentNavigationPlanning(startAddress, basePlan);
      console.log('[DEBUG] generateSuperDetailedPlan: ナビゲーションエージェントが情報収集を完了しました。');
      
      if (comprehensiveNavigationData) {
        console.log('[DEBUG] generateSuperDetailedPlan: 収集データを元にHTMLレポートを生成します...');
        //createComprehensiveHtmlReport(comprehensiveNavigationData);
      }

      const detailedPlan = {
        eventName: basePlan.eventName,
        date: basePlan.date,
        summary: basePlan.summary,
        createdAt: FieldValue.serverTimestamp()
      };
      
      console.log(`[AgentMode Planner] 詳細プランの生成が完了しました。`);
      return { status: 'success', plan: detailedPlan };

    } catch (error) {
      console.error("[AgentMode Planner] 詳細プランの生成中にエラーが発生しました:", error);
      throw new functions.https.HttpsError('internal', 'サーバー内部でエラーが発生しました。');
    }
  });
