/**
 * =================================================================
 * Day Planner用 ユーティリティ関数群 (Gen2 環境変数対応 & 安全化)
 * =================================================================
 */

const fetch = require('node-fetch');
const https = require('https'); // ★ httpsモジュールをインポート
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --------------------
// 環境変数ヘルパ
// --------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing env var ${name}. Set Secret "${name}" and attach via runWith({ secrets: ['${name}'] }).`
    );
  }
  return v;
}

function getGoogleSearchKeys() {
  return {
    apiKey: requireEnv("GOOGLE_API_KEY"),
    cseId: requireEnv("GOOGLE_CSE_ID"),
  };
}

// --------------------
// Gemini 初期化は遅延評価（起動時例外を避ける）
// --------------------
let genAI = null;
function getGenAI() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error("[Gemini] GEMINI_API_KEY が未設定です（Secret を作成し runWith でアタッチしてください）。");
    return null;
  }
  if (!genAI) {
    genAI = new GoogleGenerativeAI(key);
  }
  return genAI;
}

/**
 * Gemini APIを呼び出す共通関数 (モデル指定可能、リトライ機能付き)
 */
async function callGenerativeAi(prompt, expectJson = false, modelName = "gemini-1.5-flash-latest", maxRetries = 3) {
    const client = getGenAI();
    if (!client) {
        return null;
    }

    // フェンス除去ヘルパ
    const stripFences = (s) => {
        if (!s) return s;
        return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const model = client.getGenerativeModel({
                model: modelName,
                generationConfig: {
                    temperature: expectJson ? 0.2 : 0.0,
                    responseMimeType: expectJson ? "application/json" : "text/plain",
                }
            });

            console.log(`[Gemini] API呼び出し試行 #${attempt} (モデル: ${modelName})...`);
            const result = await model.generateContent(prompt);
            const responseTextRaw = result?.response?.text?.() ?? '';
            const responseText = stripFences(responseTextRaw);

            if (!expectJson) return (responseText || '').trim();

            // 第1パース
            try {
                return JSON.parse(responseText);
            } catch (e1) {
                console.warn(`[Gemini] JSON parse失敗(1st) → 修復パスへ: ${e1.message}`);
                // 第2パス: JSON修復をLLMに依頼
                const fixer = client.getGenerativeModel({
                    model: modelName.includes('pro') ? modelName : 'gemini-1.5-pro-latest',
                    generationConfig: { responseMimeType: 'application/json', temperature: 0 }
                });
                const fixPrompt = `次の文字列を有効なJSONに修復して、JSONデータのみを返してください。\n${responseText}`;
                const fixedRes = await fixer.generateContent(fixPrompt);
                const fixedText = stripFences(fixedRes?.response?.text?.() ?? '');
                try {
                    return JSON.parse(fixedText);
                } catch (e2) {
                    console.error(`[Gemini] JSON parse失敗(2nd): ${e2.message}`);
                    // ここでリトライ継続
                }
            }
        } catch (e) {
            const transient = e.message && (e.message.includes('503') || e.message.toLowerCase().includes('overloaded'));
            if (transient && attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
                console.warn(`[Gemini] 過負荷/一時エラー。${(delay / 1000).toFixed(1)}秒後に再試行...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            } else {
                console.error(`[Gemini] 回復不能なエラー:`, e);
                return null;
            }
        }
    }
    console.error(`[Gemini] 全ての再試行(${maxRetries}回)に失敗しました。`);
    return null;
}

/**
 * HTML取得で除外するドメインセット
 */
const EXCLUDED_DOMAINS = new Set([
    "note.com",
    "twitter.com",
    "x.com",
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "youtube.com",
    "tiktok.com",
    "pinterest.com",
    "amazon.co.jp",
    "amazon.com",
    "rakuten.co.jp",
    "rakuten.com",
    "yahoo.co.jp",
    "yahoo.com",
    // 必要に応じて追加
]);

/**
 * 指定URLが除外ドメインに該当するか判定
 */
function isExcluded(url) {
    try {
        const { hostname } = new URL(url);
        // サブドメインも含めて判定
        return [...EXCLUDED_DOMAINS].some(domain => hostname === domain || hostname.endsWith('.' + domain));
    } catch (e) {
        return false;
    }
}

/**
 * URLからHTMLコンテンツを取得するツール (SSL証明書エラー対応版, AbortController, リトライ付き, 除外ドメイン対応)
 */
async function toolGetHtmlContent(url, { minLength = 100, maxBytes = 2 * 1024 * 1024 } = {}) {
    if (isExcluded(url)) {
        console.warn(`[toolGetHtmlContent] 除外ドメインのためスキップ: ${url}`);
        return null;
    }
    const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
    };

    const timeouts = [6000, 7500];

    for (let attempt = 0; attempt < timeouts.length; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeouts[attempt]);
        try {
            const response = await fetch(url, { redirect: 'follow', agent: httpsAgent, headers, signal: controller.signal });
            clearTimeout(timeoutId);
            const ct = response.headers.get('content-type') || '';
            const cl = parseInt(response.headers.get('content-length') || '0', 10);
            if (!response.ok) return null;
            if (!/text\/html/i.test(ct)) return null;
            if (cl && cl > maxBytes) { console.warn(`[toolGetHtmlContent] content-length too large: ${cl} > ${maxBytes}`); return null; }
            const text = await response.text();
            if (!text || text.trim().length < minLength) return null;
            return text;
        } catch (error) {
            clearTimeout(timeoutId);
            const isTimeout = error.name === 'AbortError' || /timeout/i.test(error.message);
            if (attempt === 0 && isTimeout) {
                await new Promise(res => setTimeout(res, 400));
                continue; // 2回目へ
            }
            console.error(`> HTML取得ツールエラー (URL: ${url}, 試行${attempt + 1}):`, error?.type || error?.message || String(error));
            return null;
        }
    }
    return null;
}


async function getGeocodedLocation(address) {
  if (!address) return null;
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    console.error('[Geocode] GOOGLE_API_KEY が未設定です。');
    return null;
  }
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}&language=ja`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    return (data.status === 'OK' && data.results[0]) ? data.results[0].geometry.location : null;
  } catch (error) {
    console.error('[Geocode] fetch 失敗:', error?.message || error);
    return null;
  }
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
  // env helpers
  requireEnv,
  getGoogleSearchKeys,
  // ai
  callGenerativeAi,
  // http/html
  toolGetHtmlContent,
  // misc
  getGeocodedLocation,
  getWeatherDescription,
  isExcluded,
  EXCLUDED_DOMAINS,
};
