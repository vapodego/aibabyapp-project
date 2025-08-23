/**
 * =================================================================
 * 週次プランニング・バッチ (weeklyPlanner.js) - v7.6 車固定版（完全復旧）
 * =================================================================
 * - onRequest 手動実行は 202 を即返し、バックグラウンドで生成＆保存
 * - onCall はフロントアプリ向け（認証必須）。transportMode は 'car' に固定
 * - プレビューAPIを追加：保存済みプランを HTML で返す
 */

const { https } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GOOGLE_API_KEY = defineSecret("GOOGLE_API_KEY");
const GOOGLE_CSE_ID  = defineSecret("GOOGLE_CSE_ID");
const admin = require("firebase-admin");
// Initialize Admin SDK if not already initialized (safe for v2/Cloud Run)
try {
  if (!admin.apps || admin.apps.length === 0) {
    admin.initializeApp();
  }
} catch (e) {
  // already initialized elsewhere
  void e;
}
const pLimit = require("p-limit").default || require("p-limit");

// 段階別の並列度
const limitFetch = pLimit(1);   // HTML取得は外向きスパイクを防ぐため1
// const limitLite  = pLimit(3);   // 軽い判定・整形は2〜3 (unused)
const limitLLM   = pLimit(2);   // LLM呼び出しは2（必要に応じて調整）

// Promise timeout helper (to avoid indefinite hangs in LLM/tool calls)
function withTimeout(promise, ms, label = 'timeout') {
  return new Promise((resolve, reject) => {
    let finished = false;
    const t = setTimeout(() => {
      if (finished) return;
      const err = new Error(label);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
    promise.then((v) => { finished = true; clearTimeout(t); resolve(v); })
           .catch((e) => { finished = true; clearTimeout(t); reject(e); });
  });
}

// Lazy-load heavy deps on first use to avoid Cloud Run boot crashes
let agents;
let weeklyUtils;
let toolGetHtmlContent;
function ensureDepsLoaded() {
  if (!agents) {
    agents = require("./agents/weeklyPlannerAgents");
  }
  if (!weeklyUtils) {
    weeklyUtils = require("./utils/weeklyPlannerUtils");
    // sync secrets to utils (for Google CSE etc.)
    try { weeklyUtils.setSecrets({ googleKey: process.env.GOOGLE_API_KEY, cseId: process.env.GOOGLE_CSE_ID }); } catch (e) {
      // ignore secret sync failure (utils may not expose setter in tests)
      void e;
    }
  }
  if (!toolGetHtmlContent) {
    toolGetHtmlContent = weeklyUtils.toolGetHtmlContent;
  }
}

// ---- Cloud Tasks (lazy require to avoid module-not-found at deploy analyze) ----
let __CloudTasksClient = null;
function getTasksClient() {
  if (__CloudTasksClient === null) {
    try {
      const { CloudTasksClient } = require('@google-cloud/tasks');
      __CloudTasksClient = new CloudTasksClient();
    } catch (e) {
      const msg = '[CloudTasks] @google-cloud/tasks が見つかりません。functions ディレクトリで "npm i @google-cloud/tasks" を実行してください。';
      console.error(msg);
      throw new Error(msg);
    }
  }
  return __CloudTasksClient;
}

// ---- Cloud Tasks helpers (非同期実行用) ----
function getProjectId() {
  try {
    if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
    if (process.env.GCP_PROJECT) return process.env.GCP_PROJECT;
    if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
    if (process.env.FIREBASE_CONFIG) {
      return JSON.parse(process.env.FIREBASE_CONFIG).projectId;
    }
  } catch (_) { return; }
  return undefined;
}
function defaultServiceAccountEmail(pid) {
  return `${pid}@appspot.gserviceaccount.com`;
}
async function enqueueWeeklyPlannerTask({ userId, location, interests, transportMode, maxResults, dateRange, runId }) {
  const project = getProjectId();
  const region = 'asia-northeast1';
  const queueId = 'weekly-planner-queue';
  const parent = getTasksClient().queuePath(project, region, queueId);
  // queue existence (best-effort)
  try {
    await getTasksClient().getQueue({ name: parent });
  } catch (e) {
    try {
      await getTasksClient().createQueue({ parent: getTasksClient().locationPath(project, region), queue: { name: parent } });
    } catch (_) { return; }
  }
  const url = `https://${region}-${project}.cloudfunctions.net/generatePlansOnRequest?userId=${encodeURIComponent(userId)}`;
  const body = Buffer.from(JSON.stringify({ location, interests, transportMode, maxResults, dateRange, runId })).toString('base64');
  const [task] = await getTasksClient().createTask({
    parent,
    task: {
      httpRequest: {
        httpMethod: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        body,
        oidcToken: {
          serviceAccountEmail: process.env.FUNCTION_IDENTITY || defaultServiceAccountEmail(project),
          audience: url,
        },
      },
    },
  });
  return task.name;
}

// Write SuggestedPlans directly under users/{userId}/SuggestedPlans (root path)
async function _writeSuggestedPlansRoot(userId, plans) {
  const db = admin.firestore();
  const colRef = db.collection('users').doc(userId).collection('suggestedPlans');
  const batch = db.batch();
  const list = Array.isArray(plans) ? plans : [];
  list.forEach((plan, idx) => {
    const id = String(idx).padStart(3, '0');
    batch.set(colRef.doc(id), {
      ...plan,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  if (list.length === 0) {
    batch.set(colRef.doc('placeholder'), {
      placeholder: true,
      note: 'no plans (timeout/fallback)',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
}


// =================================================================
// 手動実行用の関数 (ローカル検証)
// =================================================================
exports.runWeeklyPlansManually = https.onRequest(
  { timeoutSeconds: 540, memory: "2GiB", secrets: [GOOGLE_API_KEY, GOOGLE_CSE_ID, GEMINI_API_KEY] },
  async (req, res) => {
    console.log("【ローカル実行】runWeeklyPlansManually関数がトリガーされました。");
    ensureDepsLoaded();

    // クエリから userId と UI モードを取得（既定はテストユーザー／JSON 202 応答）
    const userId = (req.query.userId || "test-user-01").toString();
    const uiMode = (req.query.ui || "json").toString(); // 'html' 指定でポーリングページを返す

    // Pre-compute URLs for logs/meta
    const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "aibabyapp-abeae";
    const region = "asia-northeast1";
    const previewUrl = `https://${region}-${projectId}.cloudfunctions.net/previewWeeklyPlans?userId=${encodeURIComponent(userId)}`;
    const statusUrl  = `https://${region}-${projectId}.cloudfunctions.net/getPlanStatus?userId=${encodeURIComponent(userId)}`;

    // ステータスを in_progress にセット
    const userRef = admin.firestore().collection("users").doc(userId);
    await userRef.set({ planGenerationStatus: "in_progress" }, { merge: true });

    // 新しい実行ランIDを払い出し、履歴ドキュメントを作成
    const runId = Date.now().toString();
    const db = admin.firestore();
    // 履歴サブコレクション名: planRuns
    const runRef = db.collection('users').doc(userId)
      .collection('planRuns').doc(runId);
    await runRef.set({
      status: 'in_progress',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      params: {
        homeAddress: '横浜市都筑区牛久保西3-10-62',
        interests: ['恐竜'],
        transportMode: 'car',
        maxResults: 5,
        dateRange: null,
      }
    }, { merge: true });
    console.log(`[run] user=${userId} runId=${runId} created planRuns doc`);

    // バックグラウンド処理開始
    (async () => {
      try {
        console.log(`> テストユーザー\n  ID: ${userId}`);
        const searchOptions = {
          homeAddress: "横浜市都筑区牛久保西3-10-62",
          interests: ["恐竜"],
          transportMode: "car", // v7.6: 常に車
          maxResults: 5,
          dateRange: null,
        };
        console.log("--- 手動実行: generatePlansForUserを開始 ---\n" + JSON.stringify(searchOptions, null, 2));
        console.log("[orchestrator] invoking generatePlansForUser...");

        const { finalPlans, allCandidateUrls, searchArea } = await withTimeout(
          generatePlansForUser(userId, searchOptions),
          8 * 60 * 1000,
          'generatePlansForUser timeout (8m)'
        );
        console.log(`[orchestrator] generatePlansForUser resolved: plans=${Array.isArray(finalPlans)?finalPlans.length:'n/a'} urls=${(allCandidateUrls||[]).length} area=${searchArea}`);
        // ラン専用サブコレクションにも保存（履歴用）
        try {
          const batch = db.batch();
          const plansCol = runRef.collection('suggestedPlans');
          (finalPlans || []).forEach((plan, idx) => {
            const id = String(idx).padStart(3, '0');
            batch.set(plansCol.doc(id), {
              ...plan,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          });
          if (!finalPlans || finalPlans.length === 0) {
            console.warn('[runRef-save] finalPlans empty -> writing placeholder doc');
            batch.set(plansCol.doc('placeholder'), {
              placeholder: true,
              note: 'no plans (timeout/fallback)',
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          }
          batch.set(runRef, {
            status: 'completed',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            suggestedCount: Array.isArray(finalPlans) ? finalPlans.length : 0,
            broadSearchArea: searchArea || null,
            allCandidateUrls: allCandidateUrls || [],
          }, { merge: true });
          console.log(`[runRef-save] writing ${finalPlans ? finalPlans.length : 0} plans to planRuns/${runId}/suggestedPlans ...`);
          await batch.commit();
          console.log('[runRef-save] batch committed');
        } catch (e) {
          console.warn('[runRef-save] 履歴保存に失敗:', e && e.message ? e.message : e);
        }
        try {
          console.log(`[root-save] writing ${finalPlans ? finalPlans.length : 0} plans to users/${userId}/suggestedPlans ...`);
          await weeklyUtils.savePlansToFirestore(finalPlans || [], userId, {
            runId,
            interests: searchOptions.interests,
            geofence: searchArea,
            transportMode: 'car',
            maxResults: searchOptions.maxResults,
            dateRange: searchOptions.dateRange,
            htmlPreviewUrl: previewUrl,
          });
          // verify write count
          try {
            const snap = await admin.firestore().collection('users').doc(userId).collection('suggestedPlans').get();
            console.log(`[root-save][verify] suggestedPlans count=${snap.size}`);
          } catch (e) {
            console.warn('[root-save][verify] failed to read back suggestedPlans:', e && e.message ? e.message : e);
          }
          console.log('[root-save] done');
        } catch (e) {
          console.error('[root-save] error:', e && e.message ? e.message : e);
        }
        try {
          await admin.firestore().collection('users').doc(userId)
            .set({ allCandidateUrls: allCandidateUrls || [] }, { merge: true });
          console.log(`[meta-save] allCandidateUrls saved (${(allCandidateUrls||[]).length})`);
        } catch (e) {
          console.warn('[meta-save] allCandidateUrls 保存に失敗:', e && e.message ? e.message : e);
        }
        console.log(`--- 手動実行 完了: 保存件数 ${finalPlans ? finalPlans.length : 0} 件 ---`);
      } catch (error) {
        console.error("[手動実行エラー]", error);
      } finally {
        // ハング防止のため、最終的に必ず completed にする（保存側で更新済みでも上書き可）
        console.log('[run] finalizing: set statuses to completed');
        try { await runRef.set({ status: 'completed' }, { merge: true }); } catch (e) {
          console.warn('Ignored error:', e && e.message ? e.message : e);
        }
        try { await userRef.set({ planGenerationStatus: 'completed' }, { merge: true }); } catch (e) {
          console.warn('Ignored error:', e && e.message ? e.message : e);
        }
      }
    })();

    if (uiMode === "html") {
      // Cloud Functions v2/Cloud Run 環境でも安定して到達できる絶対URLを生成する
      const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>週次プラン生成中...</title><script>async function poll(){try{const r=await fetch('${statusUrl}',{cache:'no-store'});const j=await r.json();if(j.status==='completed'){location.replace('${previewUrl}');return;}}catch(e){void e;} setTimeout(poll,1500);}window.addEventListener('load',poll);</script><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial;} .box{max-width:720px;margin:10vh auto;padding:24px;border:1px solid #eee;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.06);background:#fff;text-align:center} .spin{width:36px;height:36px;border:4px solid #ddd;border-top-color:#0ea5e9;border-radius:50%;margin:12px auto;animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(1turn)}}</style></head><body><div class="box"><div class="spin"></div><h1>週次プランを生成しています...</h1><p>完了すると自動的に表示ページへ移動します。</p><p style="margin-top:12px"><a href="${previewUrl}">手動で開く</a></p></div></body></html>`;
      res.set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.status(200).send(html);
    }

    // 既存のAPI互換: JSONで202を返す
    try {
      return res.status(202).json({ status: "accepted", message: "週次お出かけプラン生成をバックグラウンドで開始しました。", userId });
    } catch (_) { return; }
  }
);

// =================================================================
// アプリ（onCall）からの実行 (enqueue only)
// =================================================================
exports.generatePlansOnCall = https.onCall(
  { timeoutSeconds: 3600, memory: "2GiB", secrets: [GOOGLE_API_KEY, GOOGLE_CSE_ID, GEMINI_API_KEY] },
  async (request) => {
    const { data, auth } = request;
    ensureDepsLoaded();
    if (!auth) {
      throw new https.HttpsError("unauthenticated", "認証が必要です。");
    }
    const userId = auth.uid;
    const { location, interests, maxResults, dateRange } = data || {};
    if (!location || !Array.isArray(interests) || interests.length === 0) {
      throw new https.HttpsError("invalid-argument", "地域と興味は必須です。");
    }

    const db = admin.firestore();
    const userRef = db.collection("users").doc(userId);
    await userRef.set({ planGenerationStatus: "in_progress" }, { merge: true });

    const runId = Date.now().toString();
    const runRef = userRef.collection('planRuns').doc(runId);
    await runRef.set({
      status: 'queued',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      params: { location, interests, transportMode: 'car', maxResults, dateRange }
    }, { merge: true });

    try {
      const taskName = await enqueueWeeklyPlannerTask({
        userId,
        location,
        interests,
        transportMode: 'car',
        maxResults,
        dateRange,
        runId,
      });
      console.log('[onCall][enqueue] task created:', taskName);
    } catch (e) {
      console.error('[onCall][enqueue] failed:', e && e.message ? e.message : e);
      throw new https.HttpsError('internal', 'ジョブ投入に失敗しました。');
    }

    return { status: "processing_started", runId };
  }
);

// =================================================================
// 非同期ワーカー: Cloud Tasks から呼ばれる HTTP (onRequest)
// Body: { location, interests, transportMode, maxResults, dateRange, runId }
// Query: ?userId=...
// =================================================================
exports.generatePlansOnRequest = https.onRequest(
  { timeoutSeconds: 3600, memory: "2GiB", secrets: [GOOGLE_API_KEY, GOOGLE_CSE_ID, GEMINI_API_KEY] },
  async (req, res) => {
    try {
      ensureDepsLoaded();
      const userId = (req.query.userId || '').toString();
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      const { location, interests, maxResults, dateRange, runId: runIdBody } = req.body || {};
      if (!location || !Array.isArray(interests) || interests.length === 0) {
        return res.status(400).json({ error: 'location and interests are required' });
      }
      const runId = (runIdBody && String(runIdBody)) || Date.now().toString();

      const db = admin.firestore();
      const userRef = db.collection('users').doc(userId);
      const runRef = userRef.collection('planRuns').doc(runId);

      await userRef.set({ planGenerationStatus: 'in_progress' }, { merge: true });
      await runRef.set({
        status: 'in_progress',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        params: { location, interests, transportMode: 'car', maxResults, dateRange }
      }, { merge: true });

      // ===== メイン処理（元 onCall の同期ブロックを流用） =====
      const searchOptions = { homeAddress: location, interests, transportMode: 'car', maxResults, dateRange };
      const { finalPlans, allCandidateUrls, searchArea } = await generatePlansForUser(userId, searchOptions);

      // 履歴保存
      try {
        const batch = db.batch();
        const plansCol = runRef.collection('suggestedPlans');
        (finalPlans || []).forEach((plan, idx) => {
          const id = String(idx).padStart(3, '0');
          batch.set(plansCol.doc(id), { ...plan, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        });
        if (!finalPlans || finalPlans.length === 0) {
          batch.set(plansCol.doc('placeholder'), { placeholder: true, note: 'no plans (timeout/fallback)', createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        }
        batch.set(runRef, {
          status: 'completed',
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          suggestedCount: Array.isArray(finalPlans) ? finalPlans.length : 0,
          broadSearchArea: searchArea || null,
          allCandidateUrls: allCandidateUrls || [],
        }, { merge: true });
        await batch.commit();
        console.log('[worker][runRef-save] committed');
      } catch (e) {
        console.warn('[worker][runRef-save] 履歴保存に失敗:', e && e.message ? e.message : e);
      }

      // ルート suggestedPlans（小文字）
      try {
        await weeklyUtils.savePlansToFirestore(finalPlans || [], userId, {
          runId,
          interests,
          geofence: searchArea,
          transportMode: 'car',
          maxResults,
          dateRange,
          htmlPreviewUrl: `https://asia-northeast1-${getProjectId() || 'aibabyapp-abeae'}.cloudfunctions.net/previewWeeklyPlans?userId=${encodeURIComponent(userId)}`
        });
        console.log('[worker][root-save] done');
      } catch (e) {
        console.error('[worker][root-save] error:', e && e.message ? e.message : e);
      }

      try {
        await userRef.set({ allCandidateUrls: allCandidateUrls || [] }, { merge: true });
      } catch (e) { /* ignore */ }

      try { await runRef.set({ status: 'completed' }, { merge: true }); } catch (_) { return; }
      try { await userRef.set({ planGenerationStatus: 'completed' }, { merge: true }); } catch (_) { return; }

      return res.status(200).json({ status: 'completed', runId });
    } catch (err) {
      console.error('[generatePlansOnRequest] error', err);
      return res.status(500).json({ error: err && err.message ? err.message : String(err) });
    }
  }
);

// =================================================================
// メイン処理フロー
// =================================================================
async function generatePlansForUser(userId, userData) {
  ensureDepsLoaded();
  console.log(`--- generatePlansForUserに渡されたuserData ---`, JSON.stringify(userData, null, 2));

  // 行動範囲をAIで決定（失敗時は住所フォールバック）
  const rawSearchArea = await agents.agentGeographer(userData.homeAddress);
  console.log(`--- agentGeographerの実行結果 (RAW) ---`, rawSearchArea);
  let searchArea = rawSearchArea || userData.homeAddress;
  console.log(`--- 行動範囲を「${searchArea}」に設定 ---`);

  // 興味別に広く検索
  const userInterests = userData.interests || [];
  let allSearchResults = [];
  if (Array.isArray(userInterests) && userInterests.length > 0) {
    console.log(`[SEARCH] will start for interests:`, userInterests);
    const searchPromises = userInterests.map((interest) =>
      limitLLM(() => (async () => {
        console.log(`[SEARCH] preparing query for interest: ${interest}`);
        const searchQueryGenResult = await agents.agentBroadEventSearcher(searchArea, interest);
        console.log(`--- agentBroadEventSearcherの結果 (興味: ${interest}) ---`, JSON.stringify(searchQueryGenResult, null, 2));

        const q = searchQueryGenResult && searchQueryGenResult.query;
        if (!q) {
          console.warn(`[SEARCH] query missing for interest="${interest}" → skip`);
          return [];
        }

        // 呼び出し直前で必ずログする（ここまで到達していることを可視化）
        console.log(`> [Google検索実行] クエリ: ${q}`);
        try {
          const links = await weeklyUtils.toolGoogleSearch(q);
          const len = Array.isArray(links) ? links.length : 0;
          console.log(`[SEARCH] got ${len} links for interest="${interest}"`);
          return links || [];
        } catch (e) {
          console.error(`[SEARCH] toolGoogleSearch failed for interest="${interest}":`, e && e.message ? e.message : e);
          return [];
        }
      })())
    );

    const resultsPerInterest = await Promise.allSettled(searchPromises);
    console.log(`[SEARCH] allSettled statuses:`, resultsPerInterest.map(s => s.status));

    const resultsPerInterestOk = resultsPerInterest
      .filter(s => s.status === 'fulfilled')
      .map(s => s.value || []);

    allSearchResults = resultsPerInterestOk.flat();
    console.log(`[SEARCH] merged results count: ${allSearchResults.length}`);
  } else {
    console.log(`--- ユーザーの興味が未設定のため、広域検索を実行 ---`);
    const searchQueryGenResult = await agents.agentBroadEventSearcher(searchArea, null);
    console.log(`--- agentBroadEventSearcherの結果 (広域検索) ---`, JSON.stringify(searchQueryGenResult, null, 2));
    const q = searchQueryGenResult && searchQueryGenResult.query;
    if (q) {
      console.log(`> [Google検索実行] クエリ: ${q}`);
      try {
        allSearchResults = await weeklyUtils.toolGoogleSearch(q);
        const len = Array.isArray(allSearchResults) ? allSearchResults.length : 0;
        console.log(`[SEARCH] got ${len} links (broad search)`);
      } catch (e) {
        console.error(`[SEARCH] toolGoogleSearch failed (broad search):`, e && e.message ? e.message : e);
        allSearchResults = [];
      }
    }
  }

  if (allSearchResults.length === 0) {
    console.log("> Google検索の結果、候補が0件でした。");
    return { finalPlans: [], allCandidateUrls: [], searchArea };
  }

  const uniqueUrls = [...new Set(
    (allSearchResults || [])
      .map((r) => (typeof r === 'string' ? r : (r && r.url)))
      .filter(Boolean)
  )];
  console.log(`> 合計${allSearchResults.length}件から重複を除いた${uniqueUrls.length}件のURLを取得`);
  console.log(`[SEARCH] unique URL list size: ${uniqueUrls.length}`);

  const initialUrls = uniqueUrls;
  const allEvaluatedUrls = new Set(initialUrls);
  const targetDateRange = userData.dateRange ? `${userData.dateRange.start} to ${userData.dateRange.end}` : null;

  console.log("--- 鑑定と深掘り ---");
  const inspectionPromises = initialUrls.map((url) => (async () => {
    const htmlContent = await limitFetch(() => toolGetHtmlContent(url));
    if (!htmlContent) return null;
    const inspectionResult = await limitLLM(() => agents.agentInspector(url, htmlContent, userData, targetDateRange));
    return { url, result: inspectionResult };
  })());
  const inspectionSettled = await Promise.allSettled(inspectionPromises);
  const inspectionResults = inspectionSettled
    .filter(s => s.status === 'fulfilled' && s.value)
    .map(s => s.value);

  let validCandidates = inspectionResults
    .filter((item) => item.result?.isValid && item.result.isMatch)
    .map((item) => ({ ...item.result, url: item.url }));
  let listPageUrls = inspectionResults.filter((item) => item.result?.isListPage).map((item) => item.url);

  console.log(`> 初期鑑定: 有効候補 ${validCandidates.length}件, リストページ ${listPageUrls.length}件`);

  // リストページ深掘り
  if (listPageUrls.length > 0) {
    console.log(`--- リストページの深掘り (${listPageUrls.length}件) ---`);
    const deepDiveUrlPromises = listPageUrls.map((url) => (async () => {
      const html = await limitFetch(() => toolGetHtmlContent(url));
      if (!html) return [];
      return weeklyUtils.toolExtractEventUrls(html, url);
    })());
    const nestedUrlsSettled = await Promise.allSettled(deepDiveUrlPromises);
    const nestedUrlsArray = nestedUrlsSettled
      .filter(s => s.status === 'fulfilled')
      .map(s => s.value);
    const extractedUrls = nestedUrlsArray.flat();
    const newUrlsToInspect = [...new Set(extractedUrls)].filter((url) => !allEvaluatedUrls.has(url));

    if (newUrlsToInspect.length > 0) {
      newUrlsToInspect.forEach((url) => allEvaluatedUrls.add(url));
      console.log(`> リストページから${newUrlsToInspect.length}件の新しいURLを発見。再鑑定します。`);

      const deepDivePromises = newUrlsToInspect.map((url) => (async () => {
        if (!url) return null;
        const htmlContent = await limitFetch(() => toolGetHtmlContent(url));
        if (!htmlContent) return null;
        const inspectionResult = await limitLLM(() => agents.agentInspector(url, htmlContent, userData, targetDateRange));
        if (inspectionResult && inspectionResult.isValid && inspectionResult.isMatch) {
          return { ...inspectionResult, url };
        }
        return null;
      })());
      const deepDiveSettled = await Promise.allSettled(deepDivePromises);
      const deepDiveResults = deepDiveSettled
        .filter(s => s.status === 'fulfilled' && s.value)
        .map(s => s.value);
      validCandidates.push(...deepDiveResults);
      console.log(`> 深掘り後の合計有効候補数: ${validCandidates.length}件`);
    } else {
      console.log(`> 深掘り結果: 0件。リストページから新たなイベントURLは見つかりませんでした。`);
    }
  }

  const allUrlsArray = Array.from(allEvaluatedUrls);
  if (validCandidates.length === 0) {
    return { finalPlans: [], categorizedAlternatives: null, allCandidateUrls: allUrlsArray, searchArea };
  }

  const selectionResult = await agents.agentFinalSelector(validCandidates, userData, userData.maxResults);
  if (!selectionResult?.final_candidates?.length) {
    return { finalPlans: [], categorizedAlternatives: null, allCandidateUrls: allUrlsArray, searchArea };
  }

  const finalCandidates = selectionResult.final_candidates;
  console.log(`> ★★★ ${finalCandidates.length}件の有効な候補を確保 ★★★`);

  // --- finalPlanner section (replaced) ---
  console.log(`[finalPlanner] start for ${finalCandidates.length} candidates`);
  let finalPlans;
  try {
    finalPlans = await withTimeout(
      agents.agentFinalPlanner(finalCandidates, userData),
      2 * 60 * 1000,
      'agentFinalPlanner timeout (2m)'
    );
  } catch (e) {
    console.warn('[finalPlanner] failed or timed out. Falling back to minimal plans.', e && e.message ? e.message : e);
    const maxN = Math.min(finalCandidates.length, userData.maxResults || 3);
    finalPlans = finalCandidates.slice(0, maxN).map((c, idx) => ({
      eventName: c.eventName || c.title || `候補 ${idx + 1}`,
      url: c.url || null,
      description: c.summary || c.description || '',
      location: c.location || null,
      cost: c.cost || null,
      duration: c.duration || null,
      imageUrl: null,
      source: c.source || 'fallback',
    }));
  }
  console.log(`[finalPlanner] end: ${Array.isArray(finalPlans) ? finalPlans.length : 'n/a'} plans`);

  // 画像URL補完（og:image → 最初の<img> → Google画像検索）
  const needPatch = (finalPlans || []).filter(p => p && !p.imageUrl && p.url).length;
  console.log(`[imagePatch] start (need=${needPatch})`);
  const patchedPlans = await withTimeout(
    Promise.allSettled((finalPlans || []).map(plan => (async () => {
      if (!plan || plan.imageUrl || !plan.url) return plan;
      try {
        const html = await limitFetch(() => toolGetHtmlContent(plan.url));
        if (html) {
          const imgs = weeklyUtils.parseImagesFromHtml(plan.url, html);
          const picked = imgs.og_image || (imgs.image_list && imgs.image_list[0] && imgs.image_list[0].src) || null;
          if (picked) {
            plan.imageUrl = picked;
            return plan;
          }
        }
      } catch (e) { void e; }
      try {
        const q = `${plan.location?.name || ''} ${plan.eventName}`.trim();
        const fallback = await weeklyUtils.toolGoogleImageSearch(q);
        if (fallback) plan.imageUrl = fallback;
      } catch (e) {
        void e;
      }
      return plan;
    })())),
    90 * 1000,
    'image patch timeout (90s)'
  );
  const fulfilled = patchedPlans.filter(s => s.status === 'fulfilled').length;
  const rejected  = patchedPlans.filter(s => s.status !== 'fulfilled').length;
  console.log(`[imagePatch] settled: ok=${fulfilled} ng=${rejected}`);
  console.log('[imagePatch] end');
  const patchedPlansOk = patchedPlans
    .filter(s => s.status === 'fulfilled')
    .map(s => s.value);
  console.log(`[generatePlansForUser] returning ${patchedPlansOk.length} plans`);

  try {
    console.log('[generatePlansForUser] plan titles:', (patchedPlansOk || []).map(p => p && p.eventName).filter(Boolean));
  } catch (_) { void _; }
  return { finalPlans: patchedPlansOk, categorizedAlternatives: null, allCandidateUrls: allUrlsArray, searchArea };
}

// =================================================================
// プレビュー用: 保存済みプランをHTMLで返す
// =================================================================
exports.previewWeeklyPlans = https.onRequest(
  { timeoutSeconds: 120, memory: "512MiB", secrets: [GOOGLE_API_KEY, GOOGLE_CSE_ID, GEMINI_API_KEY] },
  async (req, res) => {
    ensureDepsLoaded();
    try {
      const db = admin.firestore();
      const userId = (req.query.userId || "test-user-01").toString();

      // 最新の実行ランを取得 (planRuns)
      const userRef = db.collection("users").doc(userId);
      const runsSnap = await userRef.collection('planRuns')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();

      let plans = [];
      let runDoc = null;
      if (!runsSnap.empty) {
        runDoc = runsSnap.docs[0];
        const plansSnap = await userRef.collection('planRuns')
          .doc(runDoc.id)
          .collection('suggestedPlans')
          .orderBy('createdAt', 'desc')
          .get();
        plans = plansSnap.docs.map(d => d.data());
      }

      // ロケーション（なければ'不明'、runのエリア優先）
      const userDoc = await userRef.get();
      const location = runDoc && runDoc.get('broadSearchArea')
        ? runDoc.get('broadSearchArea')
        : (userDoc.exists
            ? (userDoc.get('homeAddress') || userDoc.get('broadSearchArea') || '不明')
            : '不明');

      // 代替案やデバッグURLは現状未保存のため空配列
      const categorizedAlternatives = [];
      const allCandidateUrls = runDoc && Array.isArray(runDoc.get('allCandidateUrls'))
        ? runDoc.get('allCandidateUrls')
        : (userDoc.exists ? (userDoc.get('allCandidateUrls') || []) : []);

      const html = weeklyUtils.generateHtmlResponse(
        plans,
        categorizedAlternatives,
        userId,
        location,
        allCandidateUrls
      );
      res.set("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(html);
    } catch (err) {
      console.error("[previewWeeklyPlans エラー]", err);
      return res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  }
);
// =================================================================
// 生成ステータス取得API: { status: 'in_progress' | 'completed' }
// =================================================================
exports.getPlanStatus = https.onRequest(
  { timeoutSeconds: 60, memory: "256MiB", secrets: [GOOGLE_API_KEY, GOOGLE_CSE_ID, GEMINI_API_KEY] },
  async (req, res) => {
    try {
      const userId = (req.query.userId || "test-user-01").toString();
      const doc = await admin.firestore().collection('users').doc(userId).get();
      const status = doc.exists ? (doc.get('planGenerationStatus') || 'unknown') : 'unknown';
      res.set('Cache-Control','no-store');
      return res.status(200).json({ status });
    } catch (e) {
      console.error('[getPlanStatus エラー]', e);
      return res.status(500).json({ status: 'error' });
    }
  }
);

/**
 * 履歴取得API: 直近の planRuns を返す
 * GET /getPlanHistory?userId=...
 * Response: { history: PlanRun[] }
 */
exports.getPlanHistory = https.onRequest(
  { timeoutSeconds: 60, memory: "256MiB", secrets: [GOOGLE_API_KEY, GOOGLE_CSE_ID, GEMINI_API_KEY] },
  async (req, res) => {
    try {
      const userId = (req.query.userId || "test-user-01").toString();

      const runsSnap = await admin.firestore()
        .collection("users").doc(userId)
        .collection("planRuns")
        .orderBy("createdAt", "desc")
        .limit(50)
        .get();

      const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "aibabyapp-abeae";
      const region = "asia-northeast1";

      const history = runsSnap.docs.map((doc) => {
        const d = doc.data() || {};
        // 既存フィールドに不足があっても落ちないようにベストエフォートで整形
        return {
          runId: doc.id,
          status: d.status || "unknown",
          createdAt: d.createdAt || null,
          interests: d.interests || d.params?.interests || [],
          area: d.broadSearchArea || d.area || d.params?.searchArea || null,
          maxResults: d.maxResults || d.params?.maxResults || null,
          suggestedCount: Array.isArray(d.suggestedPlans) ? d.suggestedPlans.length : (d.suggestedCount || null),
          // 既存のプレビュー画面へのショートリンク
          previewUrl: `https://${region}-${projectId}.cloudfunctions.net/previewWeeklyPlans?userId=${encodeURIComponent(userId)}`,
        };
      });

      res.set("Cache-Control", "no-store");
      return res.status(200).json({ history });
    } catch (e) {
      console.error("[getPlanHistory エラー]", e);
      return res.status(500).json({ error: e && e.message ? e.message : String(e) });
    }
  }
);