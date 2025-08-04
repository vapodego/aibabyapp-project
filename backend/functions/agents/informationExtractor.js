/**
 * =================================================================
 * 情報抽出エージェント (agents/informationExtractor.js) - v1.0
 * =================================================================
 * - 担当: Gemini
 * - 目的: 指定されたURLのWebページを読み取り、Geminiの能力を使って
 * イベント名と開催地の住所を正確に抽出します。
 */

const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const functions = require("firebase-functions");

// --- 初期化 ---
const GEMINI_API_KEY = functions.config().gemini?.key;
let genAI;
if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

async function callGeminiForExtraction(htmlContent) {
    if (!genAI) {
        console.error("Gemini APIキーが設定されていません。");
        return null;
    }
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
    const prompt = `
# 指示
以下のHTMLコンテンツを分析し、開催されるイベントの正式名称と、その開催地の正確な住所を特定してください。

# 制約
- 回答は必ずJSON形式で、"eventName"と"eventAddress"の2つのキーのみを含むオブジェクトとしてください。
- 住所は都道府県から建物名や部屋番号まで、可能な限り詳細に記述してください。
- もし情報が見つからない場合は、キーの値をnullにしてください。

# HTMLコンテンツ
${htmlContent.substring(0, 15000)}...

# 出力形式
{
  "eventName": "...",
  "eventAddress": "..."
}
`;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            return JSON.parse(jsonMatch[1]);
        }
        return JSON.parse(text);
    } catch (error) {
        console.error("[Information Extractor] Geminiによる情報抽出中にエラー:", error);
        return null;
    }
}

async function extractEventInfoFromUrl(url) {
    try {
        const response = await fetch(url, { timeout: 10000 });
        if (!response.ok) {
            console.error(`[Information Extractor] URLの取得に失敗しました。Status: ${response.status}`);
            return null;
        }
        const html = await response.text();
        const extractedData = await callGeminiForExtraction(html);
        return extractedData;

    } catch (error) {
        console.error(`[Information Extractor] URL処理中にエラー: ${url}`, error);
        return null;
    }
}

module.exports = { extractEventInfoFromUrl };
