/**
 * =================================================================
 * 情報抽出エージェント (agents/informationExtractor.js) - リファクタリング版
 * =================================================================
 */

const fetch = require('node-fetch');
// ★★★ 共有ユーティリティから、リトライ機能付きのAI呼び出し関数を読み込む
const { callGenerativeAi } = require('../utils');

async function extractEventInfoFromUrl(url) {
    console.log(`[Extractor Agent] URLの処理を開始します: ${url}`);
    try {
        const response = await fetch(url, {
            timeout: 10000, redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' }
        });

        if (!response.ok) {
            console.error(`[Extractor Agent] URLの取得に失敗しました。`);
            return null;
        }

        const html = await response.text();
        if (!html || html.trim().length < 100) {
            console.error("[Extractor Agent] 取得したHTMLが短すぎるため、処理を中断します。");
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
