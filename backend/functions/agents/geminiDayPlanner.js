/**
 * =================================================================
 * Day Planner用 詳細プラン生成AIエージェント (最終FIX版)
 * =================================================================
 */
const { callGenerativeAi } = require('../utils');

async function generateDetailedDayPlan({ eventInfo, outboundRouteData, returnRouteData }) {
    console.log("[Gemini Planner] プロンプトを生成し、Gemini APIを呼び出します...");

    const prompt = `
# Role: 優秀な旅行コンシェルジュ & データアナリスト
# Task: 提供された全ての情報を元に、家族向けの完璧な1日の行動計画をJSON形式で生成する。

# Input Data:
## 1. イベント基本情報:
${JSON.stringify(eventInfo, null, 2)}
## 2. Googleマップによる詳細な経路探索結果 (行き):
// This object contains keys like 'duration', 'distance', 'summary', and 'details'.
// The 'details' object has 'highways' and 'tolls'.
${JSON.stringify(outboundRouteData.route, null, 2)}

# CRITICAL INSTRUCTIONS (絶対に遵守すること):
1.  **出力は必ずJSON形式**とすること。
2.  **"strategicGuide.logistics" フィールドの生成ルール (最重要):**
    - **以下のステップに従って、提供された経路探索結果のデータだけを使い、文章を組み立てること。**
    - **ステップ1 (所要時間):** \`duration\` の値を使い、「ご自宅から車で約[duration]です。」という文章から始める。
    - **ステップ2 (道路種別):** \`details.highways\` の値を確認する。もし "一般道のみ" 以外であれば、「主に[highways]を利用します。」と続ける。
    - **ステップ3 (料金):** \`details.tolls\` の値を確認する。もし \`null\` や "情報なし" 以外であれば、「高速料金は[tolls]です。」と続ける。
    - **例:** 入力データが \`{"duration": "26分", "details": {"highways": "第三京浜道路", "tolls": "約800円"}}\` の場合、出力は「ご自宅から車で約26分です。主に第三京浜道路を利用します。高速料金は約800円です。」となる。
    - **絶対に推測や創作をしてはならない。データがないステップは省略すること。**
3.  **"map_polyline" フィールドの生成ルール:**
    - 必ず、経路探索結果の \`map_polyline\` の文字列をそのままコピーして貼り付けること。

# JSON OUTPUT (この構造に厳密に従うこと):
{
  "planName": "恐竜たちに会いに行こう！みなとみらい大冒険",
  "schedule": "| 開始時刻 | アクティビティ | 詳細 |\\n|:---|:---|:---|\\n| 09:00 | 出発準備 | 持ち物最終チェック！ |\\n...",
  "strategicGuide": {
      "whySpecial": "このプランは子供の好奇心を刺激する恐竜イベントを中心に、家族全員が楽しめるように設計されています。",
      "logistics": "（上記CRITICAL INSTRUCTIONSに従って生成した、正確無比なアクセス情報）",
      "packingList": "飲み物, おやつ, おむつ, 着替え, おもちゃ, ウェットティッシュ, 日焼け止め"
  },
  "alternativePlan": "もし雨が降ってしまった場合は、近くの屋内施設「カップヌードルミュージアム」や「アネビートリムパーク」で遊ぶのがおすすめです。",
  "map_polyline": "..."
}`;

    const finalPlan = await callGenerativeAi(prompt, true, "gemini-1.5-pro-latest");
    
    if (finalPlan) {
      console.log("[Gemini Planner] 超高精度プランの生成に成功しました。");
      finalPlan.startLocation = outboundRouteData.route?.raw_google_response?.routes?.[0]?.legs?.[0]?.start_location;
      finalPlan.endLocation = outboundRouteData.route?.raw_google_response?.routes?.[0]?.legs?.[0]?.end_location;
    } else {
      console.error("[Gemini Planner] 超高精度プランの生成に失敗しました。");
    }
    
    return finalPlan;
}

module.exports = { generateDetailedDayPlan };
