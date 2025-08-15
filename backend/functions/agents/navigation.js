/**
 * =================================================================
 * ナビゲーション・エージェント (agents/navigation.js) - v2.2 保守性向上版
 * =================================================================
 * - 担当: Gemini
 * - 修正点: ユーザーの指摘に基づき、将来的な機能復活を容易にするため、
 * 公共交通機関関連のロジックを削除するのではなく、コメントアウトに変更。
 */

const functions = require("firebase-functions");
const fetch = require('node-fetch');
const { getGeocodedLocation } = require('../utils/geocoder');

const GOOGLE_API_KEY = functions.config().google?.key;
const RAPIDAPI_KEY = functions.config().rapidapi?.key;

/**
 * Google Maps Directions APIを使い、詳細な車ルートを取得する
 */
async function getCarRoute(startLatLon, endLatLon) {
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

/*
// =================================================================
// ▼▼▼【ここから下は、将来復活させる公共交通機関のロジックです】▼▼▼
// =================================================================

async function getTransitRoute(startLatLon, endLatLon, startTime = new Date()) {
    if (!RAPIDAPI_KEY) {
        console.error("RapidAPIキーが設定されていません。");
        return null;
    }
    const [startLat, startLon] = startLatLon.split(',');
    const [endLat, endLon] = endLatLon.split(',');

    const url = new URL('https://navitime-route-totalnavi.p.rapidapi.com/route_transit');
    const params = {
        start: `${startLat},${startLon}`,
        goal: `${endLat},${endLon}`,
        start_time: startTime.toISOString().slice(0, 16).replace('T', ' '),
        results: '1',
        sort: 'time',
    };
    url.search = new URLSearchParams(params).toString();

    console.log(`[NAVITIME API] Requesting URL: ${url.href}`);
    
    const response = await fetch(url.href, {
        method: 'GET',
        headers: {
            'X-RapidAPI-Key': RAPIDAPI_KEY,
            'X-RapidAPI-Host': 'navitime-route-totalnavi.p.rapidapi.com'
        }
    });

    if (!response.ok) {
        console.error(`Navitime API Error: ${response.status} ${response.statusText}`);
        return null;
    }
    const data = await response.json();
    return data;
}

// =================================================================
// ▲▲▲【ここまでが、将来復活させる公共交通機関のロジックです】▲▲▲
// =================================================================
*/


/**
 * ナビゲーション計画のメイン関数
 */
exports.agentNavigationPlanning = async (origin, destination, mode = 'transit') => {
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
  
  let routeData = null;
  if (mode === 'car') {
    console.log('[AGENT] 車ルートを検索します...');
    routeData = await getCarRoute(`${startCoords.lat},${startCoords.lng}`, `${endCoords.lat},${endCoords.lng}`);
  } else {
    // 公共交通機関のロジックは現在無効化されています
    console.log('[AGENT] 公共交通機関ルートを検索します... (現在無効化中)');
    // routeData = await getTransitRoute(`${startCoords.lat},${startCoords.lng}`, `${endCoords.lat},${endCoords.lng}`);
    routeData = { route_type: 'transit', summary: '公共交通機関での移動（現在無効化中）' };
  }
  
  console.log('[AGENT] ナビゲーションエージェントの処理が正常に完了しました。');
  return {
    mode: mode,
    route: routeData,
  };
};
