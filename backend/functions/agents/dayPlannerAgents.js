/**
 * =================================================================
 * Day Planner用 内部AIエージェント群 (最終FIX版)
 * =================================================================
 */
const functions = require("firebase-functions");
const fetch = require('node-fetch');
const { callGenerativeAi, toolGetHtmlContent, getWeatherDescription } = require('../utils');

async function agentEventSummarizer(eventUrl) {
    console.log(`[Summarizer Agent] 起動: ${eventUrl}`);
    const htmlContent = await toolGetHtmlContent(eventUrl);
    if (!htmlContent) return null;

    const prompt = `
# Role: 優秀なイベントレポーター
# Task: 提供されたHTMLから、イベントの全体像と具体的なアクティビティを抽出し、JSON形式で出力してください。
# Instructions:
1.  **"overview"**: イベントの魅力を伝える、少し詳しめの紹介文を作成してください。
2.  **"activities"**: イベント内で体験できる具体的なアクティビティや展示内容を、箇条書きの配列で抽出してください。（例: ["巨大ティラノサウルスの展示", "化石発掘体験コーナー", "恐竜クイズラリー"]）
# Output Format (JSON Only):
{ "overview": "...", "activities": ["...", "..."] }
# Source HTML (first 20000 chars):
${htmlContent.substring(0, 20000)}
`;
    return await callGenerativeAi(prompt, true);
}

async function agentFacilityResearcher(eventInfo) {
    console.log(`[Facility Agent] 起動: ${eventInfo.eventName}`);
    // ★★★ 別のAIを介さず、抽出済みの施設名を直接利用する ★★★
    const venueName = eventInfo.venueName;
    if (!venueName) {
        return { data: null, sourceUrl: '', notes: "会場名を特定できず、育児施設情報を見つけられませんでした。" };
    }
    console.log(`[Facility Agent] 施設名を「${venueName}」と特定。`);

    const searchQuery = `"${venueName}" ("ベビー休憩室" OR "授乳室" OR "フロアガイド" OR "オムツ交換" OR "ベビーカー")`;
    const GOOGLE_API_KEY = functions.config().google?.key;
    const GOOGLE_CX = functions.config().google?.cx;
    if (!GOOGLE_API_KEY || !GOOGLE_CX) return { data: null, sourceUrl: '', notes: "Google検索APIが設定されていません。" };

    let sourceUrl = '', pageHtml = '';
    const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(searchQuery)}&num=1`;
    try {
        const searchResponse = await fetch(searchUrl);
        const searchData = await searchResponse.json();
        if (searchData.items && searchData.items.length > 0) {
            sourceUrl = searchData.items[0].link;
            pageHtml = await toolGetHtmlContent(sourceUrl);
        }
    } catch (e) { console.error(`[Facility Agent] 検索エラー:`, e); }

    if (!pageHtml) {
        return { data: null, sourceUrl: '', notes: "公式サイト等から育児関連施設に関する詳細な情報を見つけることができませんでした。" };
    }

    const prompt = `
# Role: 綿密な情報分析家
# Task: 提供されたHTMLから、指定された4種類の育児設備に関する有無と詳細情報を見つけ出し、JSON形式で出力してください。
# 調査対象の設備:
1.  おむつ交換台
2.  授乳室
3.  調乳器/給湯器
4.  ベビーカーレンタル
# Instructions:
1.  HTML全体から、上記4つの設備に関する情報を探します。
2.  情報が見つかった場合は、対応するキーに、場所や詳細情報をまとめた文字列を格納してください。
3.  情報が見つからなかった設備のキーの値は \`null\` としてください。
4.  **必ず、以下の4つのキーをすべて含んだ単一のJSONオブジェクトとして出力してください。**
# Output Format (JSON Object Only):
{
  "diaper_station": "（見つかった詳細情報）" or null,
  "nursing_room": "（見つかった詳細情報）" or null,
  "hot_water": "（見つかった詳細情報）" or null,
  "stroller_rental": "（見つかった詳細情報）" or null
}
# Source HTML (first 30000 chars):
${pageHtml.substring(0, 30000)}
`;
    const facilitiesData = await callGenerativeAi(prompt, true);
    return { data: facilitiesData, sourceUrl: sourceUrl };
}

async function agentWeatherForecaster(latitude, longitude, dateString) {
    if (!dateString || !latitude || !longitude) return null;
    let formattedDate;
    try {
        const match = dateString.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
        formattedDate = match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : null;
    } catch (e) { return null; }
    if (!formattedDate) return null;
    
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&hourly=weathercode,temperature_2m,precipitation_probability&timezone=Asia%2FTokyo&start_date=${formattedDate}&end_date=${formattedDate}`;
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        if (data?.daily?.time?.length > 0) {
            const day = data.daily;
            const dailyDesc = getWeatherDescription(day.weathercode[0]);
            return {
                daily: { icon: dailyDesc.icon, forecast: `${dailyDesc.description}、最高 ${Math.round(day.temperature_2m_max[0])}℃ / 最低 ${Math.round(day.temperature_2m_min[0])}℃、降水確率 ${day.precipitation_probability_max[0]}%` },
                hourly: data.hourly.time.map((t, i) => ({ time: t, icon: getWeatherDescription(data.hourly.weathercode[i]).icon, temp: data.hourly.temperature_2m[i], precip: data.hourly.precipitation_probability[i] }))
            };
        }
        return null;
    } catch (error) { return null; }
}

module.exports = {
    agentEventSummarizer,
    agentFacilityResearcher,
    agentWeatherForecaster,
};
