/**
 * =================================================================
 * Geminiデイプランナー (agents/geminiDayPlanner.js) - v1.2 プロンプト最終FIX版
 * =================================================================
 * - 担当: Gemini
 * - 修正点:
 * - Geminiが意図した通りのマークダウンテーブル形式でタイムスケジュールを生成するように、
 * プロンプト（指示文）のルールをさらに厳格化し、AIの回答形式を安定させます。
 * - Few-shot learning（具体例の提示）を取り入れ、出力の精度を向上させました。
 * - 回答からテーブル部分のみを正規表現で安全に抽出するロジックを強化しました。
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const functions = require("firebase-functions");

// --- 初期化 ---
const GEMINI_API_KEY = functions.config().gemini?.key;
let genAI;
if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
} else {
    console.error("Gemini APIキーがfunctions.config()に設定されていません。");
}

/**
 * 複雑なナビゲーションデータを、Geminiが理解しやすいように要約・整形する関数
 * @param {object} data - 収集された全情報
 * @returns {string} プロンプトに埋め込むための整形済みJSON文字列
 */
function formatDataForPrompt(data) {
    // プロンプトに含める情報を厳選し、トークン量を削減しつつ品質を維持
    const simplified = {
        eventName: data.eventInfo.eventName,
        eventAddress: data.eventInfo.eventAddress,
        outbound: {
            summary: data.outboundRouteData.navitimeRoute.raw_navitime_response.items[0].summary.move,
            stationFacilities: data.outboundRouteData.stationFacilities
        },
        return: {
            summary: data.returnRouteData.navitimeRoute.raw_navitime_response.items[0].summary.move,
            stationFacilities: data.returnRouteData.stationFacilities
        }
    };
    return JSON.stringify(simplified, null, 2);
}

/**
 * Geminiを呼び出し、1日の詳細なプランを生成する
 * @param {object} collectedData - これまでのステップで収集された全情報
 * @returns {Promise<object>} - イベント名、住所、そして生成されたスケジュールを含むオブジェクト
 */
async function generateDetailedDayPlan(collectedData) {
    if (!genAI) {
        throw new Error("Gemini APIクライアントが初期化されていません。");
    }
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });

    // --- ここからが修正されたプロンプト ---
    const prompt = `
# Role
あなたは、乳幼児を連れた家族のお出かけを専門とする、超一流のコンシェルジュです。

# Goal
以下の入力情報を元に、移動、食事、休憩（おむつ替え、授乳）、イベント参加を具体的に盛り込んだ、最高の1日を過ごすための実践的なタイムスケジュールを生成してください。

# Input Data
\`\`\`json
${formatDataForPrompt(collectedData)}
\`\`\`

# Constraints
- **最重要**: 回答は、**必ず指定のマークダウンテーブル形式**で出力してください。
- テーブルの前後に挨拶や説明文などの**余計なテキストは絶対に含めないでください**。
- 回答は \`\`\`markdown で始まり、\`\`\` で終わるコードブロック形式にしてください。
- 各施設の具体的な口コミ情報（例：「〇〇ビルの授乳室は綺麗で使いやすいと評判です」）を「アクティビティ」の項目に具体的に記述してください。
- カテゴリは「移動 🚃」「電車 🚆」「休憩 🍼」「食事 🍴」「イベント ✨」「自宅 🏠」のいずれかを使用してください。
- 開始時刻と終了時刻は、入力された移動時間や常識的な滞在時間を考慮して、現実的な値を設定してください。

# Output Format Example
\`\`\`markdown
| 開始時刻 | 終了時刻 | カテゴリ | アクティビティ |
|:---|:---|:---|:---|
| 10:00 | 10:20 | 移動 🚃 | 自宅から最寄りのXX駅へ出発（徒歩約20分）。 |
| 10:35 | 11:15 | 電車 🚆 | XX線でXX駅からYY駅へ移動。 |
| 11:15 | 11:45 | 休憩 🍼 | YY駅直結の「YYデパート」3階のベビー休憩室でおむつ替え。口コミによると「午前中は比較的空いている」とのこと。 |
| 11:45 | 12:00 | 移動 🚃 | YY駅からイベント会場へ移動（徒歩約15分）。 |
| 12:00 | 15:00 | イベント ✨ | 「${collectedData.eventInfo.eventName}」を楽しむ。会場内の授乳室は2箇所。1階の授乳室は個室が3つあり、ミルク用のお湯も完備されています。 |
| 15:00 | 16:00 | 食事 🍴 | 会場近くのカフェ「ベビーフレンドリーカフェ」で遅めのランチ。ベビーカー入店可能で、子供用椅子も豊富。 |
| 16:00 | 16:30 | 休憩 🍼 | 帰りの電車に乗る前に、YY駅のベビー休憩室で再度おむつ替えと授乳。 |
| 16:45 | 17:25 | 電車 🚆 | YY線でYY駅からXX駅へ。帰りは少し混むので、端の車両がおすすめ。 |
| 17:25 | 17:45 | 移動 🚃 | XX駅から自宅へ。 |
| 17:45 | - | 自宅 🏠 | お疲れ様でした！ |
\`\`\`
`;

    try {
        console.log("[Gemini Planner] プロンプトを生成し、Gemini APIを呼び出します...");
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        // ★★★ 修正点: Geminiの回答からマークダウンテーブル部分だけを安全に抽出 ★★★
        const tableMatch = responseText.match(/```markdown\s*([\s\S]*?)\s*```/);
        
        if (!tableMatch || !tableMatch[1]) {
            console.error("[Gemini Planner ERROR] Geminiの回答からマークダウンテーブルを抽出できませんでした。Raw Response:", responseText);
            throw new Error("Geminiが期待された形式でスケジュールを生成しませんでした。");
        }
        
        const extractedTable = tableMatch[1].trim();
        console.log("[Gemini Planner] スケジュールの生成と抽出に成功しました。");

        return {
            eventName: collectedData.eventInfo.eventName,
            eventAddress: collectedData.eventInfo.eventAddress,
            schedule: extractedTable, // 抽出したテーブル部分だけを返す
        };

    } catch (error) {
        console.error("[Gemini Planner FATAL] Gemini APIの呼び出し中に致命的なエラーが発生しました:", error);
        throw new Error(`Gemini APIの呼び出しに失敗しました: ${error.message}`);
    }
}

module.exports = {
    generateDetailedDayPlan
};
