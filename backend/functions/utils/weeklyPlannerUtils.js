// --- Simple in-memory cache for fetches and Google search ---
const _inMemoryCache = {};
/**
 * Get cached value if it exists and is fresh.
 * @param {string} key
 * @param {number} maxAgeMs
 * @returns {any|null}
 */
function getCache(key, maxAgeMs) {
  const entry = _inMemoryCache[key];
  if (!entry) return null;
  if ((Date.now() - entry.ts) > maxAgeMs) return null;
  return entry.data;
}
/**
 * Set cache value for a key.
 * @param {string} key
 * @param {any} data
 */
function setCache(key, data) {
  _inMemoryCache[key] = { data, ts: Date.now() };
}
/****
 * weeklyPlannerUtils.js
 * 週次プランナー共通ユーティリティ（Firestore保存・HTMLレンダリング／検索・解析ツール）
 * ※ Cloud Functions はここに置かない（純ユーティリティ）。
 */

const admin = require("firebase-admin");
const { JSDOM } = require('jsdom');
const { FieldValue } = require("firebase-admin/firestore");
const crypto = require('crypto');

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

// ---- Firestore-backed caches (persistent) ----
const CACHE_HTML_COL = 'cache_html';        // docId = sha1(url)             (7d TTL)
const CACHE_SEARCH_COL = 'cache_search';    // docId = sha1({q,num,date})    (24h TTL)

const sha1 = (x) => crypto.createHash('sha1').update(String(x)).digest('hex');

// --- Analysis cache (LLMのページ鑑定結果を保存) -------------------
const CACHE_ANALYSIS_COL = 'cache_analysis';

/**
 * URL + HTML内容 + モデル名 (+任意のプロンプト署名) で一意キーを作る
 */
function makeInspectorKey(url, html, model = 'gemini-1.5-flash-latest', promptSig = '') {
  const contentHash = sha1(html || ''); // HTMLの内容でハッシュ
  return sha1(`${url}::${contentHash}::${model}::${promptSig}`);
}

async function getAnalysisFromCache(url, html, { model = 'gemini-1.5-flash-latest', promptSig = '' } = {}) {
  try {
    const id = makeInspectorKey(url, html, model, promptSig);
    const doc = await getCacheDoc(CACHE_ANALYSIS_COL, id);
    if (doc && doc.value) {
      logCacheHit('inspector', { url });
      return doc.value; // LLMの解析JSONオブジェクトをそのまま返す
    }
  } catch (e) {
    console.warn('[cache warn] getAnalysisFromCache failed', e && e.message ? e.message : e);
    return null;
  }
  return null;
}

async function saveAnalysisToCache(url, html, analysis, { model = 'gemini-1.5-flash-latest', promptSig = '', ttlSec = 3 * 24 * 60 * 60 } = {}) {
  try {
    const id = makeInspectorKey(url, html, model, promptSig);
    await setCacheDoc(CACHE_ANALYSIS_COL, id, {
      value: analysis,
      url,
      model,
      promptSig,
      createdAt: Date.now(),
      ttlSec
    });
    logCacheSave('inspector', { url });
  } catch (e) {
    console.warn('[cache warn] saveAnalysisToCache failed', e && e.message ? e.message : e);
    return;
  }
}

function logCacheHit(scope, info){
  try { console.log(`[cache hit] ${scope}`, info || ''); }
  catch (_) { return; }
}
function logCacheMiss(scope, info){
  try { console.log(`[cache miss] ${scope}`, info || ''); }
  catch (_) { return; }
}
function logCacheSave(scope, info){
  try { console.log(`[cache save] ${scope}`, info || ''); }
  catch (_) { return; }
}

async function getCacheDoc(col, id){
  try {
    const ref = admin.firestore().collection(col).doc(id);
    const snap = await ref.get();
    return snap.exists ? { id, ...snap.data() } : null;
  } catch(e){ console.warn('[cache] get fail', col, id, e.message); return null; }
}
async function setCacheDoc(col, id, data){
  try {
    const ref = admin.firestore().collection(col).doc(id);
    await ref.set({ ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  } catch(e){ console.warn('[cache] set fail', col, id, e.message); }
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
 * HTMLを取得（5–6秒 + 1リトライ, UA/言語ヘッダ, 除外ドメインスキップ, Firestore-backed persistent cache）
 */
async function toolGetHtmlContent(url, { minLength = 100 } = {}) {
  // Check in-memory cache first (fast path, 7d)
  const mem = getCache(url, 7 * 24 * 60 * 60 * 1000);
  if (mem) return mem;

  return limitFetch(async () => {
    if (!url) return null;
    if (isExcludedDomain(url)) { console.warn(`[HTML] excluded domain skip: ${url}`); return null; }

    // Firestore persistent cache (7d)
    const cacheId = sha1(url);
    const cache = await getCacheDoc(CACHE_HTML_COL, cacheId);
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const recentEnough = cache?.fetchedAt && (now - cache.fetchedAt < sevenDaysMs);

    let etag = cache?.etag || null;
    let lastModified = cache?.lastModified || null;

    const buildHeaders = () => {
      const h = {};
      if (etag) h['If-None-Match'] = etag;
      if (lastModified) h['If-Modified-Since'] = new Date(lastModified).toUTCString();
      return h;
    };

    if (!cache) logCacheMiss('html7d', { url });

    // 1st try (≈6s) with conditional headers
    try {
      const res = await fetchWithAbort(url, { timeoutMs: 6000, headers: buildHeaders() });
      if (res.status === 304 && cache?.body) {
        console.log('[HTML cache] 304 hit', url);
        logCacheHit('html7d-304', { url });
        setCache(url, cache.body); // warm memory cache
        return cache.body;
      }
      if (!res.ok) return null;
      const text = await res.text();
      const body = (text && text.trim().length >= minLength) ? text : null;
      if (body) {
        // persist
        await setCacheDoc(CACHE_HTML_COL, cacheId, {
          url,
          body,
          etag: res.headers.get && res.headers.get('etag') || etag || null,
          lastModified: res.headers.get && res.headers.get('last-modified') || lastModified || null,
          fetchedAt: now,
        });
        logCacheSave('html7d', { url });
        setCache(url, body);
        return body;
      }
      return null;
    } catch (e1) {
      // 2nd try (≈7.5s)
      await new Promise(r => setTimeout(r, 400));
      try {
        const res2 = await fetchWithAbort(url, { timeoutMs: 7500, headers: buildHeaders() });
        if (res2.status === 304 && cache?.body) {
          console.log('[HTML cache] 304 hit (retry)', url);
          logCacheHit('html7d-304', { url });
          setCache(url, cache.body);
          return cache.body;
        }
        if (!res2.ok) return null;
        const text2 = await res2.text();
        const body2 = (text2 && text2.trim().length >= minLength) ? text2 : null;
        if (body2) {
          await setCacheDoc(CACHE_HTML_COL, cacheId, {
            url,
            body: body2,
            etag: res2.headers.get && res2.headers.get('etag') || etag || null,
            lastModified: res2.headers.get && res2.headers.get('last-modified') || lastModified || null,
            fetchedAt: Date.now(),
          });
          logCacheSave('html7d', { url });
          setCache(url, body2);
          return body2;
        }
        // fall back to stale cache if recent
        if (recentEnough && cache?.body) {
          console.log('[HTML cache] stale serve', url);
          logCacheHit('html7d-stale', { url });
          setCache(url, cache.body);
          return cache.body;
        }
        return null;
      } catch (e2) {
        // network failure -> stale cache if recent
        if (recentEnough && cache?.body) {
          console.log('[HTML cache] stale serve (network error)', url);
          logCacheHit('html7d-stale', { url });
          setCache(url, cache.body);
          return cache.body;
        }
        console.error(`> HTML取得ツールエラー (URL: ${url}):`, e2.type || e2.message || String(e2));
        return null;
      }
    }
  });
}

/**
 * Google Custom Search API を使ってWeb検索を実行 (Firestore-backed persistent cache: 24h)
 */
async function toolGoogleSearch(query, num = 10) {
  if (!_secrets.googleApiKey || !_secrets.googleCx) {
    console.error("> Web検索中止: Google APIキーまたはCXが未設定です。");
    return [];
  }

  const dateRestrict = 'm[1]';
  const fullQuery = `${query}`.trim();

  // ---- Firestore cache (24h) for search results ----
  const keyInfo = { q: fullQuery, num, dateRestrict };
  const key = sha1(JSON.stringify(keyInfo));
  const cachedDoc = await getCacheDoc(CACHE_SEARCH_COL, key);
  const dayMs = 24 * 60 * 60 * 1000;
  if (cachedDoc?.items && cachedDoc?.cachedAt && (Date.now() - cachedDoc.cachedAt < dayMs)) {
    logCacheHit('search24h', keyInfo);
    setCache(`googleSearch:${fullQuery}:${num}`, cachedDoc.items); // warm mem cache
    return cachedDoc.items;
  }
  logCacheMiss('search24h', keyInfo);

  console.log(`> [Google検索実行] クエリ: ${fullQuery}`);
  // Use cache for search results (24h = 86400000 ms)
  const cacheKey = `googleSearch:${fullQuery}:${num}`;
  const cached = getCache(cacheKey, 24 * 60 * 60 * 1000);
  if (cached) return cached;

  const url = `https://www.googleapis.com/customsearch/v1?key=${_secrets.googleApiKey}&cx=${_secrets.googleCx}&q=${encodeURIComponent(fullQuery)}&gl=jp&hl=ja&num=${num}&dateRestrict=${dateRestrict}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    const results = data.items ? data.items.map((item) => ({ eventName: item.title, url: item.link })) : [];
    setCache(cacheKey, results); // in-memory
    await setCacheDoc(CACHE_SEARCH_COL, key, { items: results, cachedAt: Date.now(), ...keyInfo });
    logCacheSave('search24h', keyInfo);
    return results;
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
 * Firestore にプラン配列を保存（全入替）＋ 実行履歴(planRuns)を残す
 * @param {Array} plans                   生成した最終プラン配列
 * @param {string} userId                 対象ユーザーID
 * @param {Object} runMeta                任意の実行メタ情報（互換のため省略可）
 * @param {string=} runMeta.runId         実行ID（未指定なら現在時刻を基に自動採番）
 * @param {string=} runMeta.geofence      地理フィルタ（例: "横浜 OR 川崎 ..."）
 * @param {Array<string>=} runMeta.interests  興味カテゴリ
 * @param {string=} runMeta.transportMode 移動手段
 * @param {number=} runMeta.maxResults    取得希望件数
 * @param {Object=} runMeta.dateRange     日付レンジ
 * @param {string=} runMeta.htmlPreviewUrl 手動実行プレビューUI(HTML)のURL
 */
async function savePlansToFirestore(plans, userId, runMeta = {}) {
  const db = admin.firestore();
  const userRef = db.collection("users").doc(userId);
  const suggestedCol = userRef.collection("suggestedPlans");
  const runsCol = userRef.collection("planRuns");

  // runId を決定（未指定なら epoch ms を文字列で）
  const runId = runMeta.runId || String(Date.now());

  // 既存 suggestedPlans を全削除（重複回避）
  const snapshot = await suggestedCol.get();
  if (!snapshot.empty) {
    const deleteBatch = db.batch();
    snapshot.docs.forEach((doc) => deleteBatch.delete(doc.ref));
    await deleteBatch.commit();
  }

  // 追加（各プランに runId を付与）
  const planDocIds = [];
  const addBatch = db.batch();
  const items = Array.isArray(plans) ? plans : [];
  items.forEach((plan) => {
    const docRef = suggestedCol.doc();
    planDocIds.push(docRef.id);
    addBatch.set(
      docRef,
      {
        ...plan,
        runId,
        userId,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  // ステータス completed を先に同期
  addBatch.set(userRef, { planGenerationStatus: 'completed', lastPlanRunId: runId }, { merge: true });

  // 実行履歴(planRuns) を記録（後から一覧表示に使う）
  const runDocRef = runsCol.doc(runId);
  addBatch.set(
    runDocRef,
    {
      runId,
      createdAt: FieldValue.serverTimestamp(),
      planCount: items.length,
      interests: Array.isArray(runMeta.interests) ? runMeta.interests : [],
      geofence: runMeta.geofence || null,
      transportMode: runMeta.transportMode || null,
      maxResults: Number.isFinite(runMeta.maxResults) ? runMeta.maxResults : null,
      dateRange: runMeta.dateRange || null,
      htmlPreviewUrl: runMeta.htmlPreviewUrl || null,
      suggestedPlansPath: suggestedCol.path,
      suggestedPlanDocIds: planDocIds,
    },
    { merge: true }
  );

  await addBatch.commit();
  console.log('[savePlansToFirestore] wrote', items.length, 'plans for', userId, 'runId=', runId);
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
      alternativesHtml += `<div class="bg白 rounded-2xl shadow-lg p-6"><h3 class="text-2xl font-bold text-gray-700 mb-4">${category.category_title}</h3><ul class="list-disc list-inside space-y-2">`;
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
  getAnalysisFromCache,
  saveAnalysisToCache,
  // For testing/debugging, optionally expose cache helpers:
  // getCache, setCache,
  // getCacheDoc, setCacheDoc, // (uncomment for debugging)
};
