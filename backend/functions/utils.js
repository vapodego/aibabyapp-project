/**
 * =================================================================
 * Day Planner用 ユーティリティ関数群 (最終版)
 * =================================================================
 */

const functions = require("firebase-functions");
const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = functions.config().gemini?.key;
let genAI;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

/**
 * Gemini APIを呼び出す共通関数 (モデル指定可能、リトライ機能付き)
 */
async function callGenerativeAi(prompt, expectJson = false, modelName = "gemini-1.5-flash-latest", maxRetries = 3) {
    if (!genAI) {
        console.error("Gemini AIが初期化されていません。");
        return null;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const model = genAI.getGenerativeModel({
                model: modelName, // ★★★ モデル名を引数で指定できるように変更
                generationConfig: {
                    temperature: 0.0,
                    responseMimeType: expectJson ? "application/json" : "text/plain",
                }
            });
            
            console.log(`[Gemini] API呼び出し試行 #${attempt} (モデル: ${modelName})...`);
            const result = await model.generateContent(prompt);
            const responseText = result.response.text();

            if (expectJson) {
                const match = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                const jsonString = match ? match[1] : responseText;
                return JSON.parse(jsonString);
            }
            return responseText.trim();

        } catch (e) {
            if (e.message && (e.message.includes('503') || e.message.toLowerCase().includes('overloaded'))) {
                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
                    console.warn(`[Gemini] モデルが過負荷です。${(delay / 1000).toFixed(1)}秒後に再試行します...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } else {
                console.error(`[Gemini] 回復不能なエラー:`, e);
                return null; // リトライ対象外のエラーなら即終了
            }
        }
    }
    console.error(`[Gemini] 全ての再試行(${maxRetries}回)に失敗しました。`);
    return null;
}

async function toolGetHtmlContent(url) {
    try {
        const response = await fetch(url, {
            timeout: 10000, redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' }
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return null;
        return await response.text();
    } catch (error) {
        console.error(`> HTML取得ツールエラー (URL: ${url}):`, error);
        return null;
    }
}

async function getGeocodedLocation(address) {
  if (!address) return null;
  const GOOGLE_API_KEY = functions.config().google?.key;
  if (!GOOGLE_API_KEY) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}&language=ja`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    return (data.status === 'OK' && data.results[0]) ? data.results[0].geometry.location : null;
  } catch (error) { return null; }
}

function getWeatherDescription(code) {
    if (code <= 1) return { description: '晴れ', icon: '☀️' };
    if (code <= 3) return { description: '曇り', icon: '☁️' };
    if (code >= 51 && code <= 67) return { description: '雨', icon: '🌧️' };
    if (code >= 71 && code <= 86) return { description: '雪', icon: '❄️' };
    if (code >= 95 && code <= 99) return { description: '雷雨', icon: '⛈️' };
    return { description: '不明', icon: '❓' };
}

module.exports = {
    callGenerativeAi,
    toolGetHtmlContent,
    getGeocodedLocation,
    getWeatherDescription,
};
