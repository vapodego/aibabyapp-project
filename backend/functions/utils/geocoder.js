const functions = require("firebase-functions");

const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';

/**
 * 住所から緯度経度を取得するジオコーディング関数
 * @param {string} address - 変換したい住所
 * @returns {Promise<object|null>} - {lat, lng} オブジェクト、またはnull
 */
async function getGeocodedLocation(address) {
    if (!address) {
        console.warn("[GEOCODER] 住所が空のため、ジオコーディングをスキップします。");
        return null;
    }
    
    // ▼▼▼【ここを修正】APIキーの読み込みを、ファイル冒頭から関数内に移動 ▼▼▼
    const GOOGLE_API_KEY = functions.config().google?.key;

    if (!GOOGLE_API_KEY) {
        if (isEmulator) {
            console.warn("[GEOCODER] ローカル環境でGoogle APIキーが設定されていません。ジオコーディングをスキップし、nullを返します。");
            return null;
        }
        console.error("[GEOCODER] Google APIキーが設定されていません。");
        return null;
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}&language=ja`;
    console.log(`[Geocoding Attempt] address: "${address}"`);

    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.status === 'OK' && data.results[0]) {
            console.log(`[Geocoding Success] Found: ${data.results[0].formatted_address}`);
            return data.results[0].geometry.location;
        } else {
            console.warn(`[Geocoding Failed] 住所が見つかりませんでした。 Status: ${data.status}, Address: "${address}"`);
            return null;
        }
    } catch (error) {
        console.error(`[GEOCODER] ツールエラー (住所: ${address}):`, error);
        return null;
    }
}

module.exports = { getGeocodedLocation };
