/**
 * =================================================================
 * 全自動デイプランナー (dayPlanner.js) - 司令塔 (最終FIX版)
 * =================================================================
 */
const { https } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

const { extractEventInfoFromUrl } = require('./agents/informationExtractor');
const { agentNavigationPlanning } = require('./agents/navigation');
const { generateDetailedDayPlan } = require('./agents/geminiDayPlanner');
// ★★★ エージェントの各関数を直接インポートするように変更 ★★★
const { agentEventSummarizer, agentFacilityResearcher, agentWeatherForecaster } = require('./agents/dayPlannerAgents');
const { getGeocodedLocation } = require('./utils');
const { generateDayPlanHtmlResponse } = require('./htmlGenerator');

exports.runDayPlannerManually = https.onRequest(
  { timeoutSeconds: 540, memory: "2GiB" },
  async (req, res) => {
    console.log("【Day Planner 手動実行】を開始します。");
    
    const testEventUrl = "https://www.welcome.city.yokohama.jp/eventinfo/ev_detail.php?bid=yw12492";
    const testOriginAddress = "横浜市都筑区牛久保西3-10-62";

    try {
      const eventInfo = await extractEventInfoFromUrl(testEventUrl);
      if (!eventInfo) throw new Error("イベント情報を抽出できませんでした。");
      
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const userTripDate = `${tomorrow.getFullYear()}年${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日`;

      const locationQuery = eventInfo.eventAddress || eventInfo.venueName;
      const endCoords = locationQuery ? await getGeocodedLocation(locationQuery) : null;
      
      // ★★★ 直接インポートした関数を呼び出す ★★★
      const [eventDetails, facilityInfo, weatherInfo] = await Promise.all([
          agentEventSummarizer(testEventUrl),
          agentFacilityResearcher(eventInfo),
          endCoords ? agentWeatherForecaster(endCoords.lat, endCoords.lng, userTripDate) : Promise.resolve(null)
      ]);

      // 先にすべての情報を集める
      let finalPlan = { 
        ...eventInfo, 
        ...(eventDetails || {}), 
        babyInfo: facilityInfo, 
        weather: weatherInfo, 
        userTripDate: userTripDate 
      };

      if (locationQuery) {
        const [outboundRouteData, returnRouteData] = await Promise.all([
            agentNavigationPlanning(testOriginAddress, { location: { address: locationQuery } }, 'car'),
            agentNavigationPlanning(locationQuery, { location: { address: testOriginAddress } }, 'car')
        ]);
        
        if (outboundRouteData && returnRouteData) {
            const detailedPlanPart = await generateDetailedDayPlan({ eventInfo, outboundRouteData, returnRouteData });
            if (detailedPlanPart) {
                // AIが生成したプランをマージ
                finalPlan = { ...finalPlan, ...detailedPlanPart };
                // 経路情報を確実に追加する
                finalPlan.directions = outboundRouteData.route?.raw_google_response?.routes?.[0]?.legs?.[0];
            }
        }
      }
      
      const html = generateDayPlanHtmlResponse(finalPlan);
      res.status(200).send(html);

    } catch (error) {
      console.error("[Day Planner 手動実行] エラー:", error);
      res.status(500).send(`エラーが発生しました: ${error.message}`);
    }
  }
);

exports.planDayFromUrl = https.onCall(
  { timeoutSeconds: 540, memory: "2GiB" },
  async (request) => {
    const { data, auth } = request;
    if (!auth) {
      throw new https.HttpsError("unauthenticated", "認証が必要です。");
    }
    // (本番用の関数も runDayPlannerManually と同様のロジックで情報を統合してください)
    // ... 既存処理をここに実装 ...
    return { status: "not_implemented" };
  }
);
