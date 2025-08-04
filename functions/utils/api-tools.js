/**
 * =================================================================
 * APIツール (utils/api-tools.js) - v10.2 完全版
 * =================================================================
 * - 担当: Gemini
 * - 修正点:
 * - ユーザーの的確なご指摘を受け、ファイルが不完全な状態になっていた問題を解消するため、
 * 省略箇所の一切ない、完全なコードとして再提供します。
 * - ジオコーディングの精度を向上させるロジックも含まれています。
 */

const functions = require("firebase-functions");
const { Client, TravelMode } = require("@googlemaps/google-maps-services-js");

// --- 初期化 ---
const GOOGLE_MAPS_API_KEY = functions.config().google?.key;
const mapsClient = new Client({});

// --- API呼び出し & ツール関数 ---

async function toolGetCoordinates(address) {
    try {
        console.log(`[Geocoding Attempt] address: "${address}"`);
        const response = await mapsClient.geocode({
            params: {
                address: address,
                language: 'ja',
                region: 'JP', // 日本の結果を優先するようにヒントを与える
                key: GOOGLE_MAPS_API_KEY,
            },
        });

        if (response.data.status === 'OK' && response.data.results.length > 0) {
            console.log(`[Geocoding Success] Found: ${response.data.results[0].formatted_address}`);
            return response.data.results[0].geometry.location;
        }
        
        console.warn(`[Geocoding Failed] Status: ${response.data.status}. Address: "${address}"`);
        if(response.data.error_message) {
            console.warn(`[Geocoding Failed] Error Message: ${response.data.error_message}`);
        }
        return null;

    } catch (error) {
        console.error('[Google Geocode] 座標の取得中に予期せぬエラー:', error.response?.data?.error_message || error.message);
        return null;
    }
}


async function getWalkingDirectionsFromGoogle(origin, destination) {
    try {
        const response = await mapsClient.directions({
            params: {
                origin: origin,
                destination: destination,
                mode: TravelMode.walking,
                language: 'ja',
                key: GOOGLE_MAPS_API_KEY,
            },
        });

        if (response.data.status === 'OK' && response.data.routes.length > 0) {
            const route = response.data.routes[0];
            if (!route.legs || route.legs.length === 0 || !route.legs[0].steps) {
                return null;
            }
            const leg = route.legs[0];
            return {
                polyline: route.overview_polyline.points,
                steps: leg.steps.map(step => ({
                    instructions: step.html_instructions.replace(/<[^>]*>?/gm, ''),
                    distance: step.distance.value,
                })),
            };
        }
        return null;
    } catch (error) {
        console.error('[Google Walk] 徒歩ルートの取得中にエラー:', error.response?.data?.error_message || error.message);
        return null;
    }
}

async function toolSearchPlaces(location, keyword) {
    try {
        const response = await mapsClient.placesNearby({
            params: {
                location: location, radius: 1000, keyword: keyword,
                language: 'ja', key: GOOGLE_MAPS_API_KEY,
            },
        });
        if (response.data.status === 'OK') {
            return response.data.results;
        }
        return [];
    } catch (error) {
        console.error(`[Google Places] '${keyword}'の検索中にエラー:`, error.response?.data?.error_message || error.message);
        return [];
    }
}

const toolGetDirections = async (origin, destination, mode) => {
  if (mode === 'walking') {
    return getWalkingDirectionsFromGoogle(origin, destination);
  } else {
    console.warn(`[Tool] 未対応の移動モードです: ${mode}`);
    return null;
  }
};

async function toolGetPlaceDetails(placeId) {
    console.log(`[Place Details] 詳細情報を取得します。Place ID: ${placeId}`);
    try {
        const response = await mapsClient.placeDetails({
            params: {
                place_id: placeId,
                language: 'ja',
                fields: ['name', 'rating', 'reviews', 'url', 'website'],
                key: GOOGLE_MAPS_API_KEY,
            },
        });
        if (response.data.status === 'OK') {
            return response.data.result;
        }
        return null;
    } catch (error) {
        console.error(`[Place Details] 詳細情報の取得中にエラー:`, error.response?.data?.error_message || error.message);
        return null;
    }
}

module.exports = {
  toolGetCoordinates,
  toolGetDirections,
  toolSearchPlaces,
  toolGetPlaceDetails,
};
