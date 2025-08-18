/**
 * =================================================================
 * ナビゲーション・エージェント (agents/navigation.js) - v2.4 最終修正版
 * =================================================================
 * - 修正点: APIキーの読み込みをファイル冒頭から関数内に移動し、初期化エラーを完全に防止。
 */

const functions = require("firebase-functions");
const { getGeocodedLocation } = require('../utils/geocoder');

/**
 * Google Maps Directions APIを使い、詳細な車ルートを取得する
 */
async function getCarRoute(startLatLon, endLatLon) {
  // ▼▼▼【ここを修正】APIキーの読み込みを、ファイル冒頭から関数内に移動 ▼▼▼
  const GOOGLE_API_KEY = functions.config().google?.key;

  if (!GOOGLE_API_KEY) {
    console.error("Google APIキーが設定されていません。");
    return null;
  }
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${startLatLon}&destination=${endLatLon}&key=${GOOGLE_API_KEY}&language=ja&mode=driving`;
  
  console.log(`[Google Maps Directions API] Requesting URL...`);
  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' && data.routes.length > 0) {
      const route = data.routes[0];
      const leg = route.legs[0];
      
      const highways = leg.steps
        .filter(step => step.html_instructions.includes('有料道路'))
        .map(step => step.html_instructions.replace(/<[^>]*>/g, ''))
        .join(', ');

      const tollInfo = route.fare ? `${route.fare.text}` : "情報なし";
      
      return {
        route_type: 'car',
        summary: `車で約${leg.duration.text} (${leg.distance.text})`,
        duration: leg.duration.text,
        distance: leg.distance.text,
        details: {
          highways: highways || "一般道のみ",
          tolls: tollInfo
        },
        map_polyline: route.overview_polyline.points, 
        raw_google_response: data,
      };
    }
    return null;
  } catch (error) {
    console.error("[Google Maps Directions API] エラー:", error);
    return null;
  }
}

/**
 * ナビゲーション計画のメイン関数
 */
exports.agentNavigationPlanning = async (origin, destination, mode = 'car') => {
  console.log(`[AGENT] ナビゲーションエージェントが起動しました。モード: ${mode}`);
  
  const startCoords = await getGeocodedLocation(origin);
  const destinationAddress = typeof destination === 'string' ? destination : destination.location?.address;
  if (!destinationAddress) {
      throw new Error(`目的地の住所が不完全です。`);
  }
  const endCoords = await getGeocodedLocation(destinationAddress);

  if (!startCoords || !endCoords) {
      throw new Error(`ジオコーディングに失敗`);
  }
  
  console.log('[AGENT] 車ルートを検索します...');
  const routeData = await getCarRoute(`${startCoords.lat},${startCoords.lng}`, `${endCoords.lat},${endCoords.lng}`);
  
  console.log('[AGENT] ナビゲーションエージェントの処理が正常に完了しました。');
  return {
    mode: 'car',
    route: routeData,
  };
};
