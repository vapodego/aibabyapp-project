/****
 * weeklyPlannerUtils.js
 * 週次プランナー共通ユーティリティ（Firestore保存・HTMLレンダリング／検索・解析ツール）
 * ※ Cloud Functions はここに置かない（純ユーティリティ）。
 */

const admin = require("firebase-admin");
const { JSDOM } = require('jsdom');
const { FieldValue } = require("firebase-admin/firestore");

const cheerio = require('cheerio');
let pLimitLib = require('p-limit');
const pLimit = (typeof pLimitLib === 'function') ? pLimitLib : pLimitLib.default;

// --- Secrets handling (Functions v2 with Secret Manager) ---
// Default to environment variables (when attached via runWith({secrets: [...] }))
// but allow the orchestrator to inject/override them at runtime.
let _secrets = {
  googleApiKey: process.env.GOOGLE_API_KEY || null,
  googleCx: process.env.GOOGLE_CSE_ID || process.env.GOOGLE_CX || null,
};

function setSecrets({ googleKey, cseId } = {}) {
  if (googleKey) _secrets.googleApiKey = googleKey;
  if (cseId) _secrets.googleCx = cseId;
}

// --- HTML取得の共通設定（短タイムアウト + 1リトライ / UA/言語ヘッダ / 除外ドメイン） ---
const EXCLUDED_DOMAINS = new Set([
  'www.instagram.com', 'instagram.com',
  // 必要に応じて追加: 'iko-yo.net',
]);

function isExcludedDomain(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return EXCLUDED_DOMAINS.has(h);
  } catch (_) { return false; }
}

// --- Concurrency control (p-limit) ---
// "取得だけ" はネットワーク混雑・ブロック回避のため 1 並列に制限。
// それ以外（軽〜中程度処理）は 2-3 並列に抑える。
const limitFetch = pLimit(1);
const limitHeavy = pLimit(3);

async function fetchWithAbort(url, { timeoutMs = 6000, headers = {}, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        ...headers,
      }
    });
    return res;
  } finally {
    clearTimeout(id);
  }
}

/**
 * HTMLを取得（5–6秒 + 1リトライ, UA/言語ヘッダ, 除外ドメインスキップ）
 */
async function toolGetHtmlContent(url, { minLength = 100 } = {}) {
  return limitFetch(async () => {
    if (!url) return null;
    if (isExcludedDomain(url)) {
      console.warn(`[HTML] excluded domain skip: ${url}`);
      return null;
    }

    // 1st try (≈6s)
    try {
      const res = await fetchWithAbort(url, { timeoutMs: 6000 });
      if (!res.ok) return null;
      const text = await res.text();
      return (text && text.trim().length >= minLength) ? text : null;
    } catch (e1) {
      // 2nd try with small backoff and slightly longer timeout (≈7.5s)
      await new Promise(r => setTimeout(r, 400));
      try {
        const res2 = await fetchWithAbort(url, { timeoutMs: 7500 });
        if (!res2.ok) return null;
        const text2 = await res2.text();
        return (text2 && text2.trim().length >= minLength) ? text2 : null;
      } catch (e2) {
        console.error(`> HTML取得ツールエラー (URL: ${url}):`, e2.type || e2.message || String(e2));
        return null;
      }
    }
  });
}

/**
 * Google Custom Search API を使ってWeb検索を実行
 */
async function toolGoogleSearch(query, num = 10) {
  if (!_secrets.googleApiKey || !_secrets.googleCx) {
    console.error("> Web検索中止: Google APIキーまたはCXが未設定です。");
    return [];
  }

  const dateRestrict = 'm[1]';
  const fullQuery = `${query}`.trim();

  console.log(`> [Google検索実行] クエリ: ${fullQuery}`);
  const url = `https://www.googleapis.com/customsearch/v1?key=${_secrets.googleApiKey}&cx=${_secrets.googleCx}&q=${encodeURIComponent(fullQuery)}&gl=jp&hl=ja&num=${num}&dateRestrict=${dateRestrict}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    return data.items ? data.items.map((item) => ({ eventName: item.title, url: item.link })) : [];
  } catch (error) {
    console.error(`> Web検索ツールエラー (クエリ: ${query}):`, error);
    return [];
  }
}

/**
 * Cheerioを使ってHTMLからイベント詳細ページのURLを抽出
 */
function toolExtractEventUrls(html, baseUrl) {
  if (!html || !baseUrl) return [];

  const $ = cheerio.load(html);
  const urls = new Set();

  $('a').each((i, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (href.includes('/event/') || href.includes('/detail/') || href.includes('event_id=') || href.includes('/topics/')) {
      try {
        const absoluteUrl = new URL(href, baseUrl).href;
        urls.add(absoluteUrl);
      } catch (_) { /* 無視 */ }
    }
  });

  return Array.from(urls);
}

/**
 * 画像検索（フォールバック用）
 */
async function toolGoogleImageSearch(query) {
  if (!_secrets.googleApiKey || !_secrets.googleCx) return null;
  const url = `https://www.googleapis.com/customsearch/v1?key=${_secrets.googleApiKey}&cx=${_secrets.googleCx}&q=${encodeURIComponent(query)}&gl=jp&hl=ja&searchType=image&num=1`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data.items && data.items.length > 0 ? data.items[0].link : null;
  } catch (error) {
    console.error(`> 画像検索ツールエラー (クエリ: ${query}):`, error);
    return null;
  }
}

/**
 * HTMLからOG画像とimg群を抽出
 */
function parseImagesFromHtml(baseUrl, html) {
  try {
    const dom = new JSDOM(html, { url: baseUrl });
    const document = dom.window.document;
    let og_image = null;
    const ogImageElement = document.querySelector('meta[property="og:image"]');
    if (ogImageElement) {
      const ogImageUrl = ogImageElement.getAttribute('content');
      if (ogImageUrl) og_image = new URL(ogImageUrl, baseUrl).href;
    }
    const image_list = Array.from(document.querySelectorAll('img'))
      .map((img) => {
        const src = img.getAttribute('src');
        if (src && !src.startsWith('data:')) {
          try {
            return { src: new URL(src, baseUrl).href, alt: img.getAttribute('alt') };
          } catch (_) { return null; }
        }
        return null;
      })
      .filter(Boolean);
    return { og_image, image_list };
  } catch (e) {
    console.error(`> HTMLパースエラー (URL: ${baseUrl}):`, e.message);
    return { og_image: null, image_list: [] };
  }
}

/**
 * 候補イベントに最適な画像URLを選ぶ
 */
async function findBestImageForEvent(candidate, htmlContent, agentVisualScout) {
  const imageCandidates = parseImagesFromHtml(candidate.url, htmlContent);
  if (imageCandidates.og_image || imageCandidates.image_list.length > 0) {
    const result = await limitHeavy(() => agentVisualScout(candidate, imageCandidates));
    if (result && result.selectedImageUrl) return result.selectedImageUrl;
  }
  const fallbackQuery = `${candidate.location?.name || ''} ${candidate.eventName}`;
  return await toolGoogleImageSearch(fallbackQuery);
}

/**
 * Firestore にプラン配列を保存（全入替）
 */
async function savePlansToFirestore(plans, userId) {
  const db = admin.firestore();
  const userRef = db.collection("users").doc(userId);
  const collectionRef = userRef.collection("suggestedPlans");

  // 既存削除
  const snapshot = await collectionRef.get();
  if (!snapshot.empty) {
    const deleteBatch = db.batch();
    snapshot.docs.forEach((doc) => deleteBatch.delete(doc.ref));
    await deleteBatch.commit();
  }

  // 追加
  if (!plans || plans.length === 0) {
    await userRef.set({ planGenerationStatus: 'completed' }, { merge: true });
    return;
  }

  const addBatch = db.batch();
  plans.forEach((plan) => {
    const planRef = collectionRef.doc();
    addBatch.set(planRef, { ...plan, createdAt: FieldValue.serverTimestamp() });
  });
  addBatch.set(userRef, { planGenerationStatus: 'completed' }, { merge: true });

  await addBatch.commit();
}

/**
 * 保存済みプラン配列から Tailwind ベースのHTMLを生成
 */
function generateHtmlResponse(plans, categorizedAlternatives, userId, location, allCandidateUrls = []) {
  const plansHtml = (plans && plans.length > 0)
    ? plans.map((plan) => {
        const babyInfo = plan.babyInfo || {};
        const strategicGuide = plan.strategicGuide || {};
        const locationInfo = plan.location || {};
        const formatMultilineText = (data) => {
          if (Array.isArray(data)) return data.join('<br>');
          if (typeof data === 'string') return data.replace(/\n/g, '<br>');
          return '記載なし';
        };
        const sampleItineraryHtml = formatMultilineText(strategicGuide.sampleItinerary);
        const packingListHtml = formatMultilineText(strategicGuide.packingList);
        return `
        <div class="bg-white rounded-2xl shadow-lg overflow-hidden mb-8 transform hover:scale-105 transition-transform duration-300">
          <img src="${plan.imageUrl || 'https://placehold.co/600x400/e2e8f0/cbd5e0?text=No+Image'}" alt="${plan.eventName || 'イベント画像'}" class="w-full h-56 object-cover" onerror="this.onerror=null;this.src='https://placehold.co/600x400/e2e8f0/cbd5e0?text=Image+Error';">
          <div class="p-6">
            <div class="flex items-baseline mb-4"><span class="inline-block bg-teal-200 text-teal-800 text-xs px-2 rounded-full uppercase font-semibold tracking-wide">${plan.eventType || 'イベント'}</span></div>
            <div class="bg-gray-50 p-4 rounded-lg mb-4 border border-gray-200">
              <h2 class="text-xl font-bold text-gray-900"><a href="${plan.url || '#'}" target="_blank" rel="noopener noreferrer" class="hover:text-teal-600 transition-colors">イベント名：${plan.eventName || '名称不明'}</a></h2>
              <p class="text-md text-gray-700 mt-1">日程：${plan.date || '要確認'}</p>
            </div>
            <h3 class="text-2xl font-bold text-gray-800 mb-2">${plan.planName || 'おすすめプラン'}</h3>
            <p class="text-gray-600 mb-4">${plan.summary || 'AIがあなたのために作成したお出かけプランです。'}</p>
            <div class="border-t border-gray-200 pt-4"><h4 class="text-lg font-semibold text-gray-700 mb-2">💌 このプランがあなたに最適な理由</h4><p class="text-gray-600 mb-4">${strategicGuide.whySpecial || '記載なし'}</p></div>
            <div class="border-t border-gray-200 pt-4"><h4 class="text-lg font-semibold text-gray-700 mb-2">📍 基本情報</h4><ul class="list-none text-gray-600 space-y-1"><li><strong>場所:</strong> ${locationInfo.name || '場所不明'} (${locationInfo.address || '住所不明'})</li></ul></div>
            <div class="border-t border-gray-200 pt-4 mt-4"><h4 class="text-lg font-semibold text-gray-700 mb-2">✨ 完璧な家族遠征のための戦略ガイド</h4><div class="space-y-3 text-gray-600"><p><strong><span class="text-teal-600">アクセス:</span></strong> ${strategicGuide.logistics || '記載なし'}</p><p><strong><span class="text-teal-600">赤ちゃん安心情報:</span></strong> ${strategicGuide.babyInfo || '記載なし'}</p><div><strong><span class="text-teal-600">モデルプラン:</span></strong><br><div class="mt-2 pl-4 border-l-2 border-teal-200">${sampleItineraryHtml}</div></div><div><strong><span class="text-teal-600">持ち物リスト:</span></strong><br><div class="mt-2 pl-4 border-l-2 border-teal-200">${packingListHtml}</div></div></div></div>
            <div class="border-t border-gray-200 pt-4 mt-4"><h4 class="text-lg font-semibold text-gray-700 mb-2">👶 赤ちゃん向け設備</h4><div class="flex flex-wrap gap-2 text-sm"><span class="px-3 py-1 rounded-full ${babyInfo.hasNursingRoom ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'}">授乳室 ${babyInfo.hasNursingRoom ? 'あり' : 'なし'}</span><span class="px-3 py-1 rounded-full ${babyInfo.hasDiaperChangeStation ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'}">おむつ交換台 ${babyInfo.hasDiaperChangeStation ? 'あり' : 'なし'}</span><span class="px-3 py-1 rounded-full ${babyInfo.isStrollerFriendly ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'}">ベビーカーOK</span></div><p class="text-gray-600 mt-2 text-sm">${babyInfo.notes || ''}</p></div>
            <div class="border-t border-gray-200 pt-4 mt-4"><h4 class="text-lg font-semibold text-gray-700 mb-2">☔️ もしもの時の代替案</h4><p class="text-gray-600">${plan.alternativePlan || '記載なし'}</p></div>
            <div class="mt-6 text-right"><a href="${plan.url || '#'}" target="_blank" rel="noopener noreferrer" class="inline-block bg-teal-500 text-white font-bold py-2 px-4 rounded-lg hover:bg-teal-600 transition-colors">公式サイトで詳細を見る</a></div>
          </div>
        </div>`;
      }).join('')
    : '<p class="text-center text-gray-500">最終的なプラン候補は見つかりませんでした。</p>';

  let alternativesHtml = '';
  if (categorizedAlternatives && categorizedAlternatives.length > 0) {
    alternativesHtml = `<div class="mt-16"><h2 class="text-3xl font-bold text-gray-800 text-center mb-8">その他のご提案</h2><div class="space-y-8">`;
    categorizedAlternatives.forEach((category) => {
      alternativesHtml += `<div class="bg-white rounded-2xl shadow-lg p-6"><h3 class="text-2xl font-bold text-gray-700 mb-4">${category.category_title}</h3><ul class="list-disc list-inside space-y-2">`;
      category.events.forEach((event) => {
        alternativesHtml += `<li class="text-gray-600"><a href="${event.url}" target="_blank" rel="noopener noreferrer" class="text-teal-600 hover:underline">${event.eventName}</a></li>`;
      });
      alternativesHtml += `</ul></div>`;
    });
    alternativesHtml += `</div></div>`;
  }

  let allUrlsHtml = '';
  if (allCandidateUrls && allCandidateUrls.length > 0) {
    allUrlsHtml = `
      <div class="mt-16">
        <h2 class="text-2xl font-bold text-gray-700 text-center mb-4">【デバッグ用】全候補URLリスト (${allCandidateUrls.length}件)</h2>
        <div class="bg-white rounded-lg shadow p-4 text-xs text-gray-600">
          <ul class="list-disc list-inside space-y-1" style="max-height: 300px; overflow-y: auto; border: 1px solid #eee; padding: 8px;">
            ${allCandidateUrls.map((url) => `<li><a href="${url}" target="_blank" class="text-blue-500 hover:underline">${url}</a></li>`).join('')}
          </ul>
        </div>
      </div>`;
  }

  return `
<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>今週のおすすめお出かけプラン</title><script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet"><style>body { font-family: 'Inter', sans-serif; }</style></head><body class="bg-gray-100"><div class="container mx-auto p-4 md:p-8"><header class="text-center mb-10"><h1 class="text-4xl font-bold text-gray-800">今週のおすすめお出かけプラン</h1><p class="text-gray-500 mt-2">AIがあなたのために厳選しました (ユーザーID: ${userId}, 場所: ${location})</p></header><main>${plansHtml}</main>${alternativesHtml}${allUrlsHtml}</div></body></html>`;
}

// Expose limiters so orchestrators (weeklyPlanner.js 等) からも共有できる

module.exports = {
  toolGoogleSearch,
  toolGoogleImageSearch,
  findBestImageForEvent,
  parseImagesFromHtml,
  savePlansToFirestore,
  generateHtmlResponse,
  toolExtractEventUrls,
  toolGetHtmlContent,
  limitFetch,
  limitHeavy,
  setSecrets,
};
