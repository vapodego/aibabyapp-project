/**
 * =================================================================
 * 全自動デイプランナー (dayPlanner.js) - v1.5 安定版
 * =================================================================
 * - 担当: Gemini
 * - 修正点: 隠れたエラーの可能性を排除するため、これまでの修正を
 * 全て含んだ、省略箇所のない完全なコードとして再提供します。
 * - 堅牢なエラーハンドリングも含まれています。
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

const { extractEventInfoFromUrl } = require('./agents/informationExtractor');
const { agentNavigationPlanning } = require('./agents/navigation');
const { generateDetailedDayPlan } = require('./agents/geminiDayPlanner');
const { createDayPlanHtmlReport } = require('./utils/report-generator');


exports.planDayFromUrl = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .https.onCall(async (data, context) => {
    console.log('[Day Planner] 全自動プランニングを開始します。');

    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'この機能を利用するには認証が必要です。');
    }

    const userId = context.auth.uid || "test-user-id";
    const { eventUrl, originAddress } = data;

    if (!eventUrl) {
      throw new functions.https.HttpsError('invalid-argument', 'イベントURLは必須です。');
    }

    try {
      // --- ステップA: 情報抽出 ---
      console.log(`[Day Planner] ステップA: URLからイベント情報を抽出します...`);
      const eventInfo = await extractEventInfoFromUrl(eventUrl);
      if (!eventInfo || !eventInfo.eventName || !eventInfo.eventAddress) {
        throw new Error('URLからイベント名または住所を抽出できませんでした。');
      }
      console.log(`[Day Planner] > 抽出成功: ${eventInfo.eventName}`);

      // --- ステップB: 往復経路探索 ---
      const userHomeAddress = originAddress || "東京都新宿区";
      let outboundRouteData, returnRouteData;

      try {
        console.log(`[Day Planner] ステップB-1: 往路の経路を探索します...`);
        outboundRouteData = await agentNavigationPlanning(userHomeAddress, { eventName: eventInfo.eventName, location: { address: eventInfo.eventAddress } });
      } catch (error) {
        console.error("[Day Planner ERROR] 往路の経路探索中に致命的なエラーが発生しました:", error);
        throw new Error(`往路の経路探索に失敗しました: ${error.message}`);
      }
      
      try {
        console.log(`[Day Planner] ステップB-2: 復路の経路を探索します...`);
        returnRouteData = await agentNavigationPlanning(eventInfo.eventAddress, { eventName: "自宅", location: { address: userHomeAddress } });
      } catch (error) {
        console.error("[Day Planner ERROR] 復路の経路探索中に致命的なエラーが発生しました:", error);
        throw new Error(`復路の経路探索に失敗しました: ${error.message}`);
      }

      if (!outboundRouteData || !returnRouteData) {
          throw new Error('往路または復路の経路情報の取得に失敗しました。詳細はFunctionsのログを確認してください。');
      }

      // --- ステップC: Geminiによるプラン生成 ---
      console.log('[Day Planner] ステップC: Geminiが1日のプランを生成します...');
      const finalPlan = await generateDetailedDayPlan({ eventInfo, outboundRouteData, returnRouteData });

      // --- ステップD: 結果を保存 & レポート生成 ---
      console.log('[Day Planner] ステップD: 結果をFirestoreに保存し、HTMLレポートを生成します。');
      const planRef = admin.firestore().collection('users').doc(userId).collection('detailedPlans').doc();
      await planRef.set({ ...finalPlan, eventUrl: eventUrl, createdAt: FieldValue.serverTimestamp() });
      if (finalPlan) {
        createDayPlanHtmlReport(finalPlan, outboundRouteData, returnRouteData);
      }

      console.log('[Day Planner] 全ての処理が正常に完了しました。');
      return { status: 'success', planId: planRef.id, plan: finalPlan };

    } catch (error) {
      console.error("[Day Planner] 全自動プランニング中にエラーが発生しました:", error);
      throw new functions.https.HttpsError('internal', 'サーバー内部でエラーが発生しました。', error.message);
    }
  });
