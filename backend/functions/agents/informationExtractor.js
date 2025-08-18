/**
 * =================================================================
 * 情報抽出エージェント (agents/informationExtractor.js) - リファクタリング版
 * =================================================================
 */

// const fetch = require('node-fetch');
// ★★★ 共有ユーティリティから、リトライ機能付きのAI呼び出し関数を読み込む
const { callGenerativeAi } = require('../utils');
const { toolGetHtmlContent } = require('../utils/weeklyPlannerUtils');

async function extractEventInfoFromUrl(url) {
    console.log(`[Extractor Agent] URLの処理を開始します: ${url}`);
    try {
        const html = await toolGetHtmlContent(url, { minLength: 100 });
        if (!html) {
            console.error("[Extractor Agent] HTMLが取得できない/短すぎるため、処理を中断します。");
            return null;
        }
        
        const prompt = `
# 指示
以下のHTMLコンテンツからイベント情報を抽出し、指定されたJSON形式で出力してください。

# タスク詳細
1.  **eventName**: イベントの正式名称を抽出します。
2.  **venueName**: HTMLコンテンツから、イベントが開催される主要な施設名（例：「ランドマークプラザ」）を特定し、抽出してください。
3.  **eventAddress**: イベントの開催地の住所を抽出します。「所在地」「アクセス」等の見出しの近くを探してください。
4.  **eventDateString**: ウェブサイトに記載されている開催日や期間の文字列を、変更せずそのまま抽出します。(例: "2025年7月19日(土)～9月3日(日)")
5.  **planningDate**: 上記の\`eventDateString\`からイベントの**開始日**を特定し、必ず「YYYY年M月D日」の形式に変換してください。

# 制約
- 情報が見つからないキーの値は \`null\` としてください。

# HTMLコンテンツ
${html.substring(0, 30000)}

# 出力形式 (JSONのみ)
`;
        
        // ★★★ 共有のAI呼び出し関数を使用。高性能なproモデルを指定する
        const extractedData = await callGenerativeAi(prompt, true, "gemini-1.5-pro-latest");

        if(extractedData) {
            extractedData.eventUrl = url;
        }
        return extractedData;

    } catch (error) {
        console.error(`[Extractor Agent] URL処理中に致命的なエラーが発生しました:`, error);
        return null;
    }
}

module.exports = { extractEventInfoFromUrl };
