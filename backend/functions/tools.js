/**
 * =================================================================
 * 共通ツール (tools.js)
 * =================================================================
 */

const functions = require("firebase-functions");
const fetch = require('node-fetch');
const https = require('https');

// --- APIキーの初期化 ---
const GOOGLE_API_KEY = functions.config().google?.key;
const GOOGLE_CX = functions.config().google?.cx;
if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    console.error("Google Search APIのキーまたは検索エンジンIDが設定されていません。");
}

const httpsAgent = new https.Agent({
  rejectUnauthorized: process.env.FUNCTIONS_EMULATOR !== 'true'
});

/**
 * Google Custom Search APIを使ってWeb検索を実行します。
 */
async function toolGoogleSearch(query, num = 10, sort = 'relevance') {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return [];
  const fullQuery = `${query} -求人 -採用 -募集 -不動産 -転職 -株価 -中古`.trim();
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(fullQuery)}&gl=jp&hl=ja&num=${num}&dateRestrict=w1&sort=${sort}`;
  try {
    const response = await fetch(url, { agent: httpsAgent });
    const data = await response.json();
    return data.items ? data.items.map(item => ({ eventName: item.title, url: item.link })) : [];
  } catch (error) {
    console.error(`> Web検索ツールエラー (クエリ: ${query}):`, error);
    return [];
  }
}

/**
 * 指定されたURLからHTMLコンテンツを取得します。
 */
async function toolGetHtmlContent(url) {
  try {
    const response = await fetch(url, { timeout: 8000, redirect: 'follow', agent: httpsAgent });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('text/html')) return null;
    return await response.text();
  } catch (error) {
    console.error(`> HTML取得ツールエラー (URL: ${url}):`, error.message);
    return null;
  }
}

module.exports = {
  toolGoogleSearch,
  toolGetHtmlContent
};
