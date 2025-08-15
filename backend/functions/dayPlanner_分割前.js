/**
 * =================================================================
 * 全自動デイプランナー (dayPlanner.js) - v2.6 天気予報機能追加
 * =================================================================
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- AIとツールのセットアップ ---
const GEMINI_API_KEY = functions.config().gemini?.key;
let genAI;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

// ▼▼▼ 修正：AIの生応答ログを追加し、エラーハンドリングを強化 ▼▼▼
async function callGenerativeAi(prompt, expectJson = false) {
    if (!genAI) {
        console.error("Gemini AIが初期化されていません。");
        return null;
    }
    let responseText = '';
    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash-latest",
            generationConfig: {
                temperature: 0.0,
                responseMimeType: expectJson ? "application/json" : "text/plain",
            }
        });
        const result = await model.generateContent(prompt);
        responseText = result.response.text();

        console.log(`\n\n--- [Gemini Raw Response] ---\n${responseText}\n-----------------------------\n\n`);

        if (expectJson) {
             const match = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
             const jsonString = match ? match[1] : responseText;
             
             if (!jsonString || jsonString.trim() === '') {
                 console.warn('[Gemini] AIからのJSON応答が空でした。');
                 return null;
             }
             return JSON.parse(jsonString);
        }
        return responseText.trim();
    } catch (e) {
        console.error(`[Gemini] API呼び出しまたはJSON解析に失敗:`, e.message);
        console.error(`[Gemini] 解析しようとしたテキスト: ${responseText}`);
        return null;
    }
}

// ▼▼▼ 修正：User-Agentを追加し、デバッグログを強化 ▼▼▼
async function toolGetHtmlContent(url) {
    try {
        console.log(`[HTML Tool] Fetching URL: ${url}`);
        const response = await fetch(url, {
            timeout: 10000,
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
            }
        });

        const status = response.status;
        const contentType = response.headers.get('content-type');
        console.log(`[HTML Tool] Response Status: ${status}, Content-Type: ${contentType}`);

        if (!response.ok) {
            console.error(`> HTML取得ツールエラー: HTTPステータスが不正です (${status})`);
            return null;
        }
        if (!contentType || !contentType.includes('text/html')) {
            console.error(`> HTML取得ツールエラー: Content-TypeがHTMLではありません。`);
            return null;
        }

        const htmlText = await response.text();
        console.log(`[HTML Tool] Fetched content (first 150 chars): ${htmlText.substring(0, 150).replace(/\n/g, '')}...`);

        return htmlText;

    } catch (error) {
        console.error(`> HTML取得ツールで致命的なエラー (URL: ${url}):`, error.message);
        return null;
    }
}


// 外部エージェントの読み込み
const { extractEventInfoFromUrl } = require('./agents/informationExtractor');
const { agentNavigationPlanning } = require('./agents/navigation');
const { generateDetailedDayPlan } = require('./agents/geminiDayPlanner');

// イベント概要を生成するAIエージェント
async function agentEventSummarizer(eventUrl) {
    console.log(`[Summarizer Agent] 起動: ${eventUrl}`);
    const htmlContent = await toolGetHtmlContent(eventUrl);
    if (!htmlContent) {
        return "イベントのウェブサイトを読み込めませんでした。";
    }
    const prompt = `
# Role: 腕利きの旅行ガイド編集者
# Task: 提供されたウェブサイトのHTMLから、イベントの核心的な魅力を抽出し、読者の心を掴む簡潔な紹介文を作成してください。
# 絶対的なルール:
- **出力は単一のパラグラフ（改行なし）とすること。**
- **出力は5〜6行の長さに厳密に収めること。**
- **感嘆符(!)や疑問符(?)、過度な装飾、会話的な表現は使わず、プロフェッショナルで簡潔なトーンを維持すること。**
- ユーザーが「何を体験できるか」「なぜそれが特別なのか」に焦点を当てること。無駄な言葉を徹底的に排除し、要点のみをまとめること。
# Source HTML (first 12000 chars):
${htmlContent.substring(0, 12000)}
`;
    const summary = await callGenerativeAi(prompt, false);
    console.log(`[Summarizer Agent] 概要の生成完了。`);
    return summary;
}

// イベント名から施設名だけを抽出する専門家AI
async function agentVenueExtractor(eventInfo) {
    const prompt = `
# Role: データ抽出スペシャリスト
# Task: イベント名と住所から、主要な施設名（Venue Name）を1つだけ抽出してください。
# Input:
- Event Name: ${eventInfo.eventName}
- Address: ${eventInfo.eventAddress}
# Rules:
- 「恐竜祭り」のようなイベント固有の名称は完全に無視してください。
- 「ランドマークプラザ」「MARK IS みなとみらい」のような、建物や施設の固有名詞のみを出力してください。
- 出力は施設名のみのプレーンテキストとします。余計な言葉は一切含めないでください。
# Example Output:
ランドマークプラザ
`;
    return await callGenerativeAi(prompt, false);
}

// ▼▼▼【最終修正】育児関連施設を調査するAIエージェント ▼▼▼
async function agentFacilityResearcher(eventInfo) {
    console.log(`[Facility Agent] 起動: ${eventInfo.eventName}`);
    
    const venueName = await agentVenueExtractor(eventInfo);
    if (!venueName) {
        console.warn('[Facility Agent] 施設名の抽出に失敗。');
        return { facilities: [], sourceUrl: '', notes: "イベント会場の特定が困難なため、育児関連施設に関する詳細情報を見つけることができませんでした。" };
    }
    console.log(`[Facility Agent] 施設名を「${venueName}」と特定。`);

    const keywords = `"お子様連れのお客様へ" OR "ベビー休憩室" OR "授乳室" OR "フロアガイド" OR "キッズトイレ" OR "オムツ交換" OR "ベビーベッド" OR "ベビーカー" OR "施設案内"`;
    const searchQuery = `"${venueName}" (${keywords})`;

    const GOOGLE_API_KEY = functions.config().google?.key;
    const GOOGLE_CX = functions.config().google?.cx;
    if (!GOOGLE_API_KEY || !GOOGLE_CX) return null;

    let sourceUrl = '';
    let pageHtml = '';
    const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(searchQuery)}&num=1`;
    try {
        const searchResponse = await fetch(searchUrl);
        const searchData = await searchResponse.json();
        if (searchData.items && searchData.items.length > 0) {
            sourceUrl = searchData.items[0].link;
            console.log(`[Facility Agent] 最も関連性の高いページを発見: ${sourceUrl}`);
            pageHtml = await toolGetHtmlContent(sourceUrl);
        }
    } catch (e) {
        console.error(`[Facility Agent] 検索エラー:`, e);
    }

    if (!pageHtml) {
        console.warn('[Facility Agent] 施設の詳細情報を取得できませんでした。');
        return { facilities: [], sourceUrl: '', notes: "公式サイト等から育児関連施設に関する詳細な情報を見つけることができませんでした。" };
    }

    const prompt = `
# Role: 超優秀なアシスタント
# Task: あなたは、乳幼児を連れた家族のための「お出かけプラン」を作成しています。以下のHTMLから、育児に役立つ設備（授乳室、おむつ交換台、ベビーカー貸出など）に関する情報を一つ残らず抽出し、指定されたJSON形式で出力してください。これはプランの質を左右する非常に重要な作業です。

# Instructions:
1.  提供されたHTML全体を注意深く読み、育児関連のキーワード（授乳室、おむつ、ベビーカーなど）を見つけます。
2.  見つかった設備ごとに、以下のキーを持つオブジェクトを生成します。
    - **facility**: 設備の種類 (例: "授乳室", "おむつ交換台", "ベビーカー貸出", "ベビーチェア")。
    - **details**: **フロア、場所、利用時間、料金、特記事項（例：「給湯設備あり」）など、親にとって有益な情報を具体的かつ簡潔に**まとめた文字列。
3.  **絶対に諦めないでください。** HTML内に情報があるはずです。徹底的に探し、見つけた情報をすべて抽出してください。
4.  もし、あらゆる努力をしても情報が見つからなかった場合に限り、空の配列を返してください。

# Output Format (JSON Array of Objects only):
[
  {
    "facility": "ベビー休憩室(授乳室)",
    "details": "ランドマークプラザ 4F / 個室3室、おむつ交換台4台、給湯設備、離乳食販売機あり。利用時間は11:00～20:00。"
  },
  {
    "facility": "おむつ交換台",
    "details": "各フロアの多目的トイレ、女性トイレ内に設置されています。"
  },
  {
    "facility": "ベビーカー貸出",
    "details": "1F インフォメーションカウンターにて貸出。生後2ヶ月～24ヶ月までが対象。料金は無料。"
  }
]

# Source HTML (first 30000 chars):
${pageHtml.substring(0, 30000)}
`;
    const facilities = await callGenerativeAi(prompt, true);
    console.log('[Facility Agent] 施設調査完了。');

    return {
        facilities: facilities || [],
        sourceUrl: sourceUrl
    };
}


// ★★★【ここからが追加/修正された箇所です】★★★

/**
 * 住所を緯度経度に変換するジオコーディング関数
 */
async function getGeocodedLocation(address) {
  if (!address) return null;
  const GOOGLE_API_KEY = functions.config().google?.key;
  if (!GOOGLE_API_KEY) {
      console.error("Geocoding Error: Google API Key is not configured.");
      return null;
  }
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}&language=ja`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.status === 'OK' && data.results[0]) {
      return data.results[0].geometry.location;
    }
    console.warn(`Geocoding failed for address "${address}": ${data.status}`);
    return null;
  } catch (error) {
    console.error(`Geocoding fetch error for address "${address}":`, error);
    return null;
  }
}

/**
 * 天気予報を取得するエージェント
 */
// dayPlanner.js の agentWeatherForecaster 関数を置き換え

// dayPlanner.js の agentWeatherForecaster 関数を置き換え

async function agentWeatherForecaster(latitude, longitude, dateString) {
    if (!dateString || !latitude || !longitude) return null;

    let formattedDate;
    try {
        const match = dateString.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
        if (match) {
            formattedDate = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
        } else {
            formattedDate = new Date(dateString).toISOString().split('T')[0];
        }
    } catch (e) { return null; }
    
    const targetDate = new Date(formattedDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((targetDate - today) / (1000 * 60 * 60 * 24));
    if (diffDays < 0 || diffDays > 15) return { daily: { icon: '📅', forecast: '予報範囲外です' }, hourly: [] };

    // ▼▼▼【ここを修正】hourlyパラメータを追加して時間ごとの情報を要求 ▼▼▼
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&hourly=weathercode,temperature_2m,precipitation_probability&timezone=Asia%2FTokyo&start_date=${formattedDate}&end_date=${formattedDate}`;

    try {
        console.log(`[Weather Agent] ${formattedDate}の天気(日別+時間別)を取得中...`);
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();

        if (data?.daily?.time?.length > 0) {
            const day = data.daily;
            const dailyDescription = getWeatherDescription(day.weathercode[0]);
            const dailyForecast = {
                icon: dailyDescription.icon,
                forecast: `${dailyDescription.description}、最高 ${Math.round(day.temperature_2m_max[0])}℃ / 最低 ${Math.round(day.temperature_2m_min[0])}℃、降水確率 ${day.precipitation_probability_max[0]}%`
            };

            const hourlyForecast = data.hourly.time.map((t, i) => {
                const hourlyDescription = getWeatherDescription(data.hourly.weathercode[i]);
                return {
                    time: t,
                    icon: hourlyDescription.icon,
                    temp: data.hourly.temperature_2m[i],
                    precip: data.hourly.precipitation_probability[i]
                };
            });
            
            return { daily: dailyForecast, hourly: hourlyForecast };
        }
        return null;
    } catch (error) {
        console.error('[Weather Agent] 天気情報の取得エラー:', error);
        return null;
    }
}

/**
 * 天気コードをアイコンと説明に変換するヘルパー関数
 */
function getWeatherDescription(code) {
    if (code === 0) return { description: '快晴', icon: '☀️' };
    if (code === 1) return { description: '晴れ', icon: '☀️' };
    if (code === 2) return { description: '一部曇り', icon: '🌤️' };
    if (code === 3) return { description: '曇り', icon: '☁️' };
    if (code >= 51 && code <= 67) return { description: '雨', icon: '🌧️' };
    if (code >= 71 && code <= 86) return { description: '雪', icon: '❄️' };
    if (code >= 95 && code <= 99) return { description: '雷雨', icon: '⛈️' };
    return { description: '不明', icon: '❓' };
}


/**
 * 手動実行用の関数 (テスト用)
 */
// dayPlanner.js の runDayPlannerManually 関数を置き換え

exports.runDayPlannerManually = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .https.onRequest(async (req, res) => {
    console.log("【Day Planner 手動実行】を開始します。");
    
    const testEventUrl = "https://www.welcome.city.yokohama.jp/eventinfo/ev_detail.php?bid=yw12492";
    const testOriginAddress = "横浜市都筑区牛久保西3-10-62";

    try {
      const eventInfo = await extractEventInfoFromUrl(testEventUrl);
      // AIがplanningDateを生成するので、その存在をチェック
      if (!eventInfo || !eventInfo.planningDate) {
        throw new Error("必須情報(planningDate)をAIが抽出できませんでした。");
      }
      console.log("イベント情報の抽出成功:", eventInfo);
      
      // ユーザーが実際に行く日（今回は'明日'に固定）
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const userTripDate = `${tomorrow.getFullYear()}年${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日`;
      console.log(`[DEV] ユーザーの出発予定日を「${userTripDate}」に設定します。`);

      const endCoords = eventInfo.eventAddress ? await getGeocodedLocation(eventInfo.eventAddress) : null;
      
      const [eventOverview, facilityInfo, weatherInfo] = await Promise.all([
          agentEventSummarizer(testEventUrl),
          agentFacilityResearcher(eventInfo),
          // 天気予報には、ユーザーの出発予定日を使う
          endCoords ? agentWeatherForecaster(endCoords.lat, endCoords.lng, userTripDate) : Promise.resolve(null)
      ]);

      let finalPlan = { 
        ...eventInfo,
        overview: eventOverview, 
        babyInfo: facilityInfo, 
        weather: weatherInfo 
      };

      if (eventInfo.eventAddress) {
        const [outboundRouteData, returnRouteData] = await Promise.all([
            agentNavigationPlanning(testOriginAddress, { location: { address: eventInfo.eventAddress } }, 'car'),
            agentNavigationPlanning(eventInfo.eventAddress, { location: { address: testOriginAddress } }, 'car')
        ]);
        
        if (outboundRouteData && returnRouteData) {
           let detailedPlanPart = null;
    for (let i = 0; i < 3; i++) { // 最大3回試行
        console.log(`[Day Planner] 詳細プラン生成を試みます... (${i + 1}回目)`);
        detailedPlanPart = await generateDetailedDayPlan({ eventInfo, outboundRouteData, returnRouteData });
        if (detailedPlanPart) {
            console.log("[Day Planner] 詳細プランの生成に成功しました。");
            break; // 成功したらループを抜ける
        }
        if (i < 2) {
            console.warn(`[Day Planner] 詳細プラン生成に失敗。5秒待機してリトライします...`);
            await new Promise(resolve => setTimeout(resolve, 5000)); // 5秒待つ
        }
    }}
      }
      
      const html = generateDayPlanHtmlResponse(finalPlan);
      res.status(200).send(html);

    } catch (error) {
      console.error("[Day Planner 手動実行] エラー:", error);
      res.status(500).send(`エラーが発生しました: ${error.message}`);
    }
  });

/**
 * アプリから呼び出す本番用の関数
 */
exports.planDayFromUrl = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .https.onCall(async (data, context) => {
    try {
      if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'この機能を利用するには認証が必要です。');
      }
      const userId = context.auth.uid;
      const { eventUrl, originAddress, transportMode } = data;
      if (!eventUrl) {
        throw new functions.https.HttpsError('invalid-argument', 'イベントURLは必須です。');
      }
      
      console.log(`[Day Planner] 開始: ユーザーID: ${userId}, URL: ${eventUrl}, 交通手段: ${transportMode}`);

      // ▼▼▼【修正点】情報抽出後のチェックを強化 ▼▼▼
      const eventInfo = await extractEventInfoFromUrl(eventUrl);
      if (!eventInfo || !eventInfo.eventName || !eventInfo.eventAddress) {
        console.error("イベント情報の抽出に失敗、または必須情報(eventName, eventAddress)が不足しています。", eventInfo);
        throw new functions.https.HttpsError('not-found', '指定されたURLからイベント情報（特にイベント名と住所）を抽出できませんでした。');
      }
      console.log("イベント情報の抽出成功:", eventInfo);
const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const planningDate = `${tomorrow.getFullYear()}年${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日`;
      console.log(`[DEV] 計画日を一時的に明日「${planningDate}」に設定して処理を続行します。`);
     
      const destinationAddress = eventInfo.eventAddress;
      const endCoords = destinationAddress ? await getGeocodedLocation(destinationAddress) : null;

      const [eventOverview, facilityInfo, weatherInfo] = await Promise.all([
          agentEventSummarizer(eventUrl),
          agentFacilityResearcher(eventInfo), // ここに渡される eventInfo が健全であることを保証
          endCoords ? agentWeatherForecaster(endCoords.lat, endCoords.lng, eventInfo.date) : Promise.resolve(null)
      ]);

      let finalPlan = {
          planName: eventInfo.eventName,
          eventName: eventInfo.eventName,
          eventUrl: eventUrl,
          overview: eventOverview,
          babyInfo: facilityInfo,
          weather: weatherInfo,
      };

      if (eventInfo.eventAddress) {
          const userHomeAddress = originAddress || "東京都新宿区";
          const [outboundRouteData, returnRouteData] = await Promise.all([
            agentNavigationPlanning(userHomeAddress, { eventName: eventInfo.eventName, location: { address: eventInfo.eventAddress } }, transportMode),
            agentNavigationPlanning(eventInfo.eventAddress, { eventName: "自宅", location: { address: userHomeAddress } }, transportMode)
          ]);

          if (outboundRouteData && returnRouteData) {
             let detailedPlanPart = null;
    for (let i = 0; i < 3; i++) {
        console.log(`[Day Planner] 詳細プラン生成を試みます... (${i + 1}回目)`);
        detailedPlanPart = await generateDetailedDayPlan({ eventInfo, outboundRouteData, returnRouteData });
        if (detailedPlanPart) {
            console.log("[Day Planner] 詳細プランの生成に成功しました。");
            break;
        }
        if (i < 2) {
            console.warn(`[Day Planner] 詳細プラン生成に失敗。5秒待機してリトライします...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }}

              finalPlan = { ...finalPlan, ...detailedPlanPart };
              finalPlan.directions = outboundRouteData.route?.raw_google_response?.routes?.[0]?.legs?.[0];
              finalPlan.startLocation = outboundRouteData.route?.raw_google_response?.routes?.[0]?.legs?.[0]?.start_location;
              finalPlan.endLocation = outboundRouteData.route?.raw_google_response?.routes?.[0]?.legs?.[0]?.end_location;
          }
      }

      const planRef = admin.firestore().collection('users').doc(userId).collection('detailedPlans').doc();
      await planRef.set({ ...finalPlan, createdAt: FieldValue.serverTimestamp() });
      console.log('[Day Planner] Firestoreへのプラン保存が完了しました。');

      console.log('[Day Planner] 全ての処理が正常に完了しました。');
      return { status: 'success', plan: finalPlan };

    } catch (error) {
      console.error("[Day Planner] 全自動プランニング中にエラーが発生しました:", error);
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      throw new functions.https.HttpsError('internal', 'サーバー内部でエラーが発生しました。', error.message);
    }
  });


/**
 * 結果をHTMLで見やすく表示するヘルパー関数
 */
/**
 * 結果をHTMLで見やすく表示するヘルパー関数
 */
function generateDayPlanHtmlResponse(plan) {
    const GOOGLE_API_KEY = functions.config().google?.key;
    
    const decodePolyline = (encoded) => {
        if (!encoded) return [];
        let index = 0, len = encoded.length;
        let lat = 0, lng = 0;
        let array = [];
        while (index < len) {
            let b, shift = 0, result = 0;
            do {
                b = encoded.charCodeAt(index++) - 63;
                result |= (b & 0x1f) << shift;
                shift += 5;
            } while (b >= 0x20);
            let dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lat += dlat;
            shift = 0;
            result = 0;
            do {
                b = encoded.charCodeAt(index++) - 63;
                result |= (b & 0x1f) << shift;
                shift += 5;
            } while (b >= 0x20);
            let dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lng += dlng;
            array.push({ lat: lat / 1e5, lng: lng / 1e5 });
        }
        return array;
    };

    const decodedCoords = decodePolyline(plan.map_polyline);
    
    const parseScheduleForCard = (scheduleText) => {
        if (!scheduleText || typeof scheduleText !== 'string') return [];
        try {
            const lines = scheduleText.split('\n').filter(line => line.startsWith('|') && !line.includes('---') && line.trim().length > 2);
            return lines.map(line => {
                const parts = line.split('|').map(s => s.trim()).filter(Boolean);
                if (parts.length >= 2) {
                    return { time: parts[0], activity: parts[1], details: parts[2] || '' };
                }
                return null;
            }).filter(Boolean);
        } catch { return []; }
    };

    const hourlyWeatherMap = new Map();
    if (plan.weather?.hourly) {
        plan.weather.hourly.forEach(hourData => {
            const hour = new Date(hourData.time).getHours();
            hourlyWeatherMap.set(hour, {
                icon: hourData.icon,
                temp: Math.round(hourData.temp)
            });
        });
    }

    let scheduleCardHtml = '<p>スケジュール情報がありません。</p>';
    if (plan.schedule) {
        const scheduleItems = parseScheduleForCard(plan.schedule);
        if(scheduleItems.length > 0) {
            const scheduleRowsHtml = scheduleItems.map(item => {
                const isDeparture = item.activity.includes('出発') && plan.directions;
                const timeForInput = item.time.match(/(\d{2}:\d{2})/)?.[0] || '12:00';
                const scheduleHourMatch = item.time.match(/^(\d{2}):/);
                const scheduleHour = scheduleHourMatch ? parseInt(scheduleHourMatch[1], 10) : -1;
                const weatherForHour = hourlyWeatherMap.get(scheduleHour);

                return `
                    <div class="flex items-center py-3 border-b border-gray-100 last:border-b-0">
                        <div class="w-32 md:w-40 flex items-center shrink-0">
                            <span class="font-bold text-gray-800">${item.time}</span>
                            <input type="time" value="${timeForInput}" class="ml-2 p-1 border rounded-md text-xs bg-gray-50 focus:outline-blue-500">
                        </div>
                        <div class="flex-1 pl-4">
                            <div class="flex items-center">
                                <p class="font-semibold text-gray-700">${item.activity}</p>
                                ${weatherForHour ? `<span class="ml-3 text-sm font-medium text-gray-500">${weatherForHour.icon} ${weatherForHour.temp}°C</span>` : ''}
                            </div>
                            ${item.details ? `<p class="text-sm text-gray-500 mt-1">${item.details}</p>`: ''}
                        </div>
                        ${isDeparture ? `<button onclick="showRouteModal()" class="ml-4 bg-blue-500 text-white text-xs font-bold py-1 px-3 rounded-full hover:bg-blue-600 whitespace-nowrap">経路詳細</button>` : ''}
                    </div>
                `;
            }).join('');
            scheduleCardHtml = `<div class="flow-root">${scheduleRowsHtml}</div>`;
        }
    }

    const directionsHtml = plan.directions?.steps?.map(step => {
        let icon = '➡️';
        if (step.maneuver) {
            if (step.maneuver.includes('turn-right')) icon = '↪️';
            if (step.maneuver.includes('turn-left')) icon = '↩️';
            if (step.maneuver.includes('merge')) icon = '🔄';
            if (step.maneuver.includes('roundabout')) icon = '🔄';
            if (step.maneuver.includes('straight')) icon = '⬆️';
        }
        if (step.html_instructions.includes('有料道路')) icon = '🛣️';
        if (step.html_instructions.includes('目的地')) icon = '🏁';
        return `
            <div class="flex items-start py-3 border-b border-gray-100">
                <div class="text-2xl mr-3 pt-1">${icon}</div>
                <div class="flex-1">
                    <div class="text-sm text-gray-800">${step.html_instructions.replace(/<div.*?>/g, '<span class="text-xs text-gray-500">').replace(/<\/div>/g, '</span>')}</div>
                    <div class="text-xs text-gray-500 mt-1">${step.duration.text} (${step.distance.text})</div>
                </div>
            </div>`;
    }).join('') || '<p>詳細な経路情報はありません。</p>';
    
    let babyInfoHtml = `<p class="pl-10 text-gray-400">${plan.babyInfo?.notes || '（育児設備の情報は見つかりませんでした）'}</p>`;
    if (plan.babyInfo && Array.isArray(plan.babyInfo.facilities) && plan.babyInfo.facilities.length > 0) {
        const tableRows = plan.babyInfo.facilities.map(item => `
            <tr>
                <td class="px-4 py-2 border-t font-semibold">${item.facility}</td>
                <td class="px-4 py-2 border-t">${item.details}</td>
            </tr>
        `).join('');
        
        const sourceLink = plan.babyInfo.sourceUrl 
            ? `<div class="text-xs text-right mt-2">情報参照元: <a href="${plan.babyInfo.sourceUrl}" target="_blank" class="text-blue-500 hover:underline">公式サイト等</a></div>` 
            : '';

        babyInfoHtml = `
            <div class="pl-10">
                <table class="table-auto w-full text-sm">
                    <thead>
                        <tr>
                            <th class="px-4 py-2 text-left bg-gray-50 w-1/4">設備</th>
                            <th class="px-4 py-2 text-left bg-gray-50">場所・詳細</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows}
                    </tbody>
                </table>
                ${sourceLink}
            </div>
        `;
    }

    return `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Day Planner 実行結果</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://maps.googleapis.com/maps/api/js?key=${GOOGLE_API_KEY}&callback=initMap" async defer></script>
        <style>
            .content-card { background-color: white; border-radius: 0.75rem; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); padding: 1.5rem; margin-bottom: 2rem; }
            .section-header { display: flex; align-items: center; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #f3f4f6; }
            .section-title { font-size: 1.125rem; font-weight: 700; color: #374151; margin-left: 0.75rem; }
            .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(0,0,0,0.5); z-index: 40; display: none; }
            .modal-content { position: fixed; bottom: 0; left: 0; right: 0; max-height: 75%; background-color: white; z-index: 50; transform: translateY(100%); transition: transform 0.3s ease-in-out; }
            .modal-open .modal-content { transform: translateY(0); }
        </style>
    </head>
    <body class="bg-gray-50">
        <div class="container mx-auto p-4 md:p-8 max-w-4xl">
            <img src="https://images.unsplash.com/photo-1599382245363-34596954a1b0?q=80&w=2070&auto=format&fit=crop" alt="イベントのイメージ画像" class="w-full h-64 object-cover rounded-lg shadow-lg mb-6">
            <div class="content-card -mt-16 z-10 relative">
                <h1 class="text-3xl font-extrabold text-gray-900 text-center mb-4">${plan.planName || 'イベントプラン'}</h1>

                <div class="border border-gray-200 rounded-lg overflow-hidden mb-4">
 <table class="w-full text-sm">
    <tbody>
        <tr>
            <td class="px-4 py-3 bg-gray-50 font-semibold text-gray-600 w-1/4">イベント名</td>
            <td class="px-4 py-3 text-gray-800">${plan.eventName || '情報なし'}</td>
        </tr>
        <tr>
            {/* ▼▼▼【ここを修正】「日程」を「開催日」に、plan.dateをplan.eventDateに変更 ▼▼▼ */}
            <td class="px-4 py-3 bg-gray-50 font-semibold text-gray-600 border-t">開催日</td>
            <td class="px-4 py-3 text-gray-800 border-t">${plan.eventDate || '要確認'}</td>
        </tr>
        <tr>
            <td class="px-4 py-3 bg-gray-50 font-semibold text-gray-600 border-t">天気予報</td>
                                <td class="px-4 py-3 text-gray-800 border-t">
                                    ${plan.weather?.daily ? `${plan.weather.daily.icon} ${plan.weather.daily.forecast}` : '当日のお楽しみ'}
                                </td>
                            </tr>
                            <tr>
                                <td class="px-4 py-3 bg-gray-50 font-semibold text-gray-600 border-t">場所</td>
                                <td class="px-4 py-3 text-gray-800 border-t">${plan.directions?.end_address || '情報なし'}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div class="text-center mb-6">
                    <a href="${plan.eventUrl || '#'}" target="_blank" class="text-blue-500 hover:underline">公式サイトで詳細を見る →</a>
                </div>

                <div class="text-base text-gray-700 leading-relaxed mb-8 text-center bg-amber-50 p-4 rounded-lg">
                     ${plan.overview || '<p>概要を生成できませんでした。</p>'}
                </div>
                <div class="section-header">
                    <span class="text-2xl">💌</span>
                    <h2 class="section-title">このプランがあなたに最適な理由</h2>
                </div>
                <p class="text-gray-600 pl-10 mb-8">${plan.strategicGuide?.whySpecial || '記載なし'}</p>
                <div class="section-header">
                    <span class="text-2xl">👶</span>
                    <h2 class="section-title">赤ちゃん向け設備</h2>
                </div>
                ${babyInfoHtml}
                <div class="section-header mt-8">
                     <span class="text-2xl">☔️</span>
                    <h2 class="section-title">もしもの時の代替案</h2>
                </div>
                <p class="pl-10 mb-8 text-gray-400">${plan.alternativePlan || '（現在この項目は開発中です）'}</p>
            </div>
            
            <div class="content-card">
                 <div class="section-header">
                    <span class="text-2xl">✨</span>
                    <h2 class="section-title">完璧な家族遠征のための戦略ガイド</h2>
                </div>
                <div class="pl-10 text-gray-600 space-y-2 mb-8">
                    <table class="table-auto w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                        <tbody>
                            <tr>
                                <td class="px-4 py-3 bg-gray-50 font-semibold text-gray-600 w-1/4">アクセス</td>
                                <td class="px-4 py-3 text-gray-800">${plan.strategicGuide?.logistics || '記載なし'}</td>
                            </tr>
                            <tr>
                                <td class="px-4 py-3 bg-gray-50 font-semibold text-gray-600 border-t">持ち物リスト</td>
                                <td class="px-4 py-3 text-gray-800 border-t">${plan.strategicGuide?.packingList || '記載なし'}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div class="section-header">
                    <span class="text-2xl">🗓️</span>
                    <h2 class="section-title">1日のモデルスケジュール</h2>
                </div>
                <div class="pl-2 md:pl-10 text-gray-600">
                    ${scheduleCardHtml}
                </div>
            </div>
        </div>

        <div id="modal-overlay" class="modal-overlay" onclick="hideRouteModal()"></div>
        <div id="route-modal" class="modal-content rounded-t-lg">
            <div class="p-4 border-b flex justify-between items-center">
                <button onclick="hideRouteModal()" class="text-2xl text-gray-500 hover:text-gray-800">×</button>
                <h2 class="text-xl font-bold text-gray-800">移動ルート詳細</h2>
                <button onclick="openGoogleMaps()" class="bg-green-500 text-white text-xs font-bold py-1 px-3 rounded-full hover:bg-green-600 whitespace-nowrap">Google Mapで見る</button>
            </div>
            <div class="p-4 overflow-y-auto">
                <div class="flex flex-col md:flex-row gap-6">
                    <div class="w-full md:w-1/2 overflow-y-auto max-h-96">
                        ${directionsHtml}
                    </div>
                    <div class="w-full md:w-1/2 h-96 rounded-lg shadow-md">
                        <div id="map" style="width: 100%; height: 100%;"></div>
                    </div>
                </div>
            </div>
        </div>
        
        <script>
            let map;
            function initMap() {
                const decodedCoords = ${JSON.stringify(decodedCoords)};
                const startLocation = ${JSON.stringify(plan.startLocation)};
                const endLocation = ${JSON.stringify(plan.endLocation)};
                if (!decodedCoords || decodedCoords.length === 0) {
                    document.getElementById('map').innerHTML = '<p class="text-center text-gray-500 p-4">経路データがないため、地図を表示できません。</p>';
                    return;
                };
                map = new google.maps.Map(document.getElementById('map'), { mapTypeControl: false, streetViewControl: false, });
                const routePath = new google.maps.Polyline({ path: decodedCoords, geodesic: true, strokeColor: '#FF6347', strokeOpacity: 0.8, strokeWeight: 6, });
                routePath.setMap(map);
                if (startLocation) new google.maps.Marker({ position: startLocation, map: map, title: '出発地' });
                if (endLocation) new google.maps.Marker({ position: endLocation, map: map, title: '目的地' });
                const bounds = new google.maps.LatLngBounds();
                decodedCoords.forEach(coord => bounds.extend(coord));
                map.fitBounds(bounds);
            }
            
            const routeModal = document.getElementById('route-modal');
            const modalOverlay = document.getElementById('modal-overlay');
            const body = document.body;
            function showRouteModal() {
                modalOverlay.style.display = 'block';
                body.classList.add('modal-open');
                if (typeof google !== 'undefined' && map) {
                     setTimeout(() => {
                        google.maps.event.trigger(map, 'resize');
                        const bounds = new google.maps.LatLngBounds();
                        const decodedCoords = ${JSON.stringify(decodedCoords)};
                        if (decodedCoords && decodedCoords.length > 0) {
                            decodedCoords.forEach(coord => bounds.extend(coord));
                            map.fitBounds(bounds);
                        }
                     }, 300);
                }
            }
            function hideRouteModal() {
                modalOverlay.style.display = 'none';
                body.classList.remove('modal-open');
            }

            function openGoogleMaps() {
                const destination = encodeURIComponent("${plan.directions?.end_address || ''}");
                if (destination) {
                    const url = \`https://www.google.com/maps/dir/?api=1&destination=\${destination}\`;
                    window.open(url, '_blank');
                } else {
                    alert('目的地情報がありません。');
                }
            }
        </script>
    </body>
    </html>
    `;
}