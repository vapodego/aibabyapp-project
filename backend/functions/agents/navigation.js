/**
 * =================================================================
 * ナビゲーションエージェント (agents/navigation.js) - v4.17 完全版
 * =================================================================
 * - 担当: Gemini
 * - 修正点:
 * - ユーザーの的確なご指摘を受け、ファイルが不完全な状態になっていた問題を解消するため、
 * 省略箇所の一切ない、完全なコードとして再提供します。
 * - これまでのデバッグで成功した全てのロジック（エラーハンドリング、ジオコーディング等）を含んでいます。
 */

const functions = require("firebase-functions");
const fetch = require('node-fetch');
const { toolGetDirections, toolSearchPlaces, toolGetCoordinates, toolGetPlaceDetails } = require('../utils/api-tools');

// --- NAVITIME API 実装 ---
const NAVITIME_API_KEY = functions.config().navitime?.key;
const NAVITIME_HOST = functions.config().navitime?.host;

async function getTransitDirectionsFromNavitime(origin, destination) {
    try {
        if (!NAVITIME_API_KEY || !NAVITIME_HOST) {
            throw new Error("NAVITIMEのAPIキーまたはホストが設定されていません。");
        }

        console.log(`[GEOCODER] 出発地をジオコーディング中: ${origin}`);
        const originCoords = await toolGetCoordinates(origin);
        console.log(`[GEOCODER] 目的地をジオコーディング中: ${destination}`);
        const destinationCoords = await toolGetCoordinates(destination);

        if (!originCoords || !destinationCoords) {
            throw new Error("出発地または目的地のジオコーディングに失敗しました。");
        }

        const startLocation = `${originCoords.lat},${originCoords.lng}`;
        const goalLocation = `${destinationCoords.lat},${destinationCoords.lng}`;
        console.log(`[GEOCODER] 変換完了: ${startLocation} -> ${goalLocation}`);

        const startTime = new Date(Date.now() + 9 * 60 * 60 * 1000 + 10 * 60 * 1000).toISOString().slice(0, 19);

        const params = new URLSearchParams({
            start: startLocation,
            goal: goalLocation,
            start_time: startTime,
            search_type: 'departure',
            results: 1,
            sort: 'time',
        });
        
        const url = `https://${NAVITIME_HOST}/route_transit?${params.toString()}`;
        console.log(`[NAVITIME API] Requesting URL: ${url}`);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'X-RapidAPI-Key': NAVITIME_API_KEY,
                'X-RapidAPI-Host': NAVITIME_HOST
            }
        });

        if (!response.ok) {
            const errorBody = await response.json();
            throw new Error(`NAVITIME API request failed with status ${response.status}. Message: ${errorBody.message}`);
        }
        
        const data = await response.json();
        
        if (data && data.items) {
            return { status: 'success', raw_navitime_response: data };
        } else {
            throw new Error('Unexpected response format from NAVITIME API.');
        }

    } catch (error) {
        console.error("[NAVITIME API ERROR]", error);
        return { status: 'error', message: error.message };
    }
}

// --- ヘルパー関数 ---
function extractStations(navitimeRaw) {
    if (!navitimeRaw || !navitimeRaw.items || !navitimeRaw.items[0]) return [];
    return navitimeRaw.items[0].sections
        .filter(s => s.type === 'point' && s.node_types?.includes('station'))
        .map(s => ({ name: s.name, lat: s.coord?.lat, lon: s.coord?.lon }));
}

async function searchFacilitiesAroundStations(stations) {
    const facilitiesData = {};
    const searchKeywords = {
        nursingRooms: "授乳室|ベビー休憩室",
        elevators: "エレベーター",
        accessibleToilets: "多目的トイレ|多機能トイレ"
    };
    for (const station of stations) {
        if (station.name && station.lat && station.lon) {
            console.log(`[FACILITY SCOUT] ${station.name}駅周辺の施設を検索中...`);
            facilitiesData[station.name] = { nursingRooms: [], elevators: [], accessibleToilets: [] };
            const location = `${station.lat},${station.lon}`;
            for (const [key, keyword] of Object.entries(searchKeywords)) {
                const places = await toolSearchPlaces(location, keyword);
                if (places && places.length > 0) {
                    const placesWithDetails = [];
                    for (let i = 0; i < places.length && i < 1; i++) {
                        const place = places[i];
                        if (place.place_id) {
                            const details = await toolGetPlaceDetails(place.place_id);
                            placesWithDetails.push({ ...place, details });
                        } else {
                            placesWithDetails.push(place);
                        }
                    }
                    facilitiesData[station.name][key] = placesWithDetails;
                }
            }
        } else {
            console.warn(`[FACILITY SCOUT] ${station.name || '不明な駅'}の座標情報が不完全なため、施設検索をスキップします。`);
        }
    }
    return facilitiesData;
}

async function getDetailedWalkingRoutes(navitimeRaw, originAddress, destinationAddress) {
    if (!navitimeRaw || !navitimeRaw.items || !navitimeRaw.items[0]) return { start: null, end: null };
    const sections = navitimeRaw.items[0].sections;
    const points = sections.filter(s => s.type === 'point');
    const firstStation = points.find(p => p.node_types?.includes('station'));
    const lastStation = points.slice().reverse().find(p => p.node_types?.includes('station'));
    let startWalk = null;
    let endWalk = null;

    if (firstStation?.coord?.lat && firstStation?.coord?.lon) {
        console.log(`[WALK ROUTE] 自宅 -> ${firstStation.name}駅 の徒歩ルートを検索中...`);
        const firstStationCoords = `${firstStation.coord.lat},${firstStation.coord.lon}`;
        startWalk = await toolGetDirections(originAddress, firstStationCoords, 'walking');
    } else {
        console.warn(`[WALK ROUTE] 最初の駅の座標が不完全なため、徒歩ルート(start)の検索をスキップします。`);
    }

    if (lastStation?.coord?.lat && lastStation?.coord?.lon) {
        console.log(`[WALK ROUTE] ${lastStation.name}駅 -> 目的地 の徒歩ルートを検索中...`);
        const lastStationCoords = `${lastStation.coord.lat},${lastStation.coord.lon}`;
        endWalk = await toolGetDirections(lastStationCoords, destinationAddress, 'walking');
    } else {
        console.warn(`[WALK ROUTE] 最後の駅の座標が不完全なため、徒歩ルート(end)の検索をスキップします。`);
    }

    return { start: startWalk, end: endWalk };
}


/**
 * ナビゲーションエージェントのメイン機能
 */
async function agentNavigationPlanning(originAddress, basePlan) {
    try {
        console.log('[AGENT] ナビゲーションエージェントが起動しました。');
        const navitimeRoute = await getTransitDirectionsFromNavitime(originAddress, basePlan.location.address);
        
        if (navitimeRoute.status !== 'success' || !navitimeRoute.raw_navitime_response.items) {
            throw new Error(navitimeRoute.message || "NAVITIME APIから有効な経路が取得できませんでした。");
        }
        console.log('[AGENT] ステップ1/3: 公共交通機関ルートの取得完了 (LIVE)');
        const transitStations = extractStations(navitimeRoute.raw_navitime_response);
        const stationFacilities = await searchFacilitiesAroundStations(transitStations);
        console.log('[AGENT] ステップ2/3: 乗り換え駅の施設情報収集完了');
        const detailedWalks = await getDetailedWalkingRoutes(navitimeRoute.raw_navitime_response, originAddress, basePlan.location.address);
        console.log('[AGENT] ステップ3/3: 詳細な徒歩ルートの取得完了');
        const comprehensiveData = { navitimeRoute, stationFacilities, detailedWalks, basePlan };
        console.log('[AGENT] ナビゲーションエージェントの処理が正常に完了しました。');
        return comprehensiveData;
    } catch (error) {
        console.error('[AGENT ERROR] ナビゲーションエージェントの処理中にエラーが発生しました:', error.message);
        return null; // エラー発生時は明確にnullを返す
    }
}

module.exports = {
    agentNavigationPlanning
};
