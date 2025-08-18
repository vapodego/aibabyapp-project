/**
 * =================================================================
 * 週次プランニング・バッチ (weeklyPlanner.js) - v7.6 車固定版（完全復旧）
 * =================================================================
 * - onRequest 手動実行は 202 を即返し、バックグラウンドで生成＆保存
 * - onCall はフロントアプリ向け（認証必須）。transportMode は 'car' に固定
 * - プレビューAPIを追加：保存済みプランを HTML で返す
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const pLimit = require("p-limit");
// 段階別の並列度
const limitFetch = pLimit(1);   // HTML取得は外向きスパイクを防ぐため1
const limitLite  = pLimit(3);   // 軽い判定・整形は2〜3
const limitLLM   = pLimit(2);   // LLM呼び出しは2（必要に応じて調整）

const agents = require("./agents/weeklyPlannerAgents");
const weeklyUtils = require("./utils/weeklyPlannerUtils");
const { toolGetHtmlContent } = require("./utils/weeklyPlannerUtils");

// =================================================================
// 手動実行用の関数 (ローカル検証)
// =================================================================
exports.runWeeklyPlansManually = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 540, memory: "2GB", secrets: ["GOOGLE_API_KEY", "GOOGLE_CSE_ID"] })
  .https.onRequest(async (req, res) => {
    console.log("【ローカル実行】runWeeklyPlansManually関数がトリガーされました。");

    // クエリから userId と UI モードを取得（既定はテストユーザー／JSON 202 応答）
    const userId = (req.query.userId || "test-user-01").toString();
    const uiMode = (req.query.ui || "json").toString(); // 'html' 指定でポーリングページを返す

    // ステータスを in_progress にセット
    const userRef = admin.firestore().collection("users").doc(userId);
    await userRef.set({ planGenerationStatus: "in_progress" }, { merge: true });

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

        const { finalPlans, allCandidateUrls } = await generatePlansForUser(userId, searchOptions);
        await weeklyUtils.savePlansToFirestore(finalPlans || [], userId); // 内部で completed に更新
        try {
          await admin.firestore().collection('users').doc(userId)
            .set({ allCandidateUrls: allCandidateUrls || [] }, { merge: true });
        } catch (e) {
          console.warn('[meta-save] allCandidateUrls 保存に失敗:', e && e.message ? e.message : e);
        }
        console.log(`--- 手動実行 完了: 保存件数 ${finalPlans ? finalPlans.length : 0} 件 ---`);
      } catch (error) {
        console.error("[手動実行エラー]", error);
        await userRef.set({ planGenerationStatus: "completed" }, { merge: true });
      }
    })();

    if (uiMode === "html") {
      // ポーリングして自動でプレビューへ遷移する簡易UIを返す
      const previewUrl = `/aibabyapp-abeae/asia-northeast1/previewWeeklyPlans?userId=${encodeURIComponent(userId)}`;
      const statusUrl = `/aibabyapp-abeae/asia-northeast1/getPlanStatus?userId=${encodeURIComponent(userId)}`;
      const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>週次プラン生成中...</title><script>async function poll(){try{const r=await fetch('${statusUrl}',{cache:'no-store'});const j=await r.json();if(j.status==='completed'){location.replace('${previewUrl}');return;} }catch(e){} setTimeout(poll, 1500);}window.addEventListener('load', poll);</script><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial;} .box{max-width:720px;margin:10vh auto;padding:24px;border:1px solid #eee;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.06);background:#fff;text-align:center} .spin{width:36px;height:36px;border:4px solid #ddd;border-top-color:#0ea5e9;border-radius:50%;margin:12px auto;animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(1turn)}}</style></head><body><div class="box"><div class="spin"></div><h1>週次プランを生成しています...</h1><p>完了すると自動的に表示ページへ移動します。</p><p style="margin-top:12px"><a href="${previewUrl}">手動で開く</a></p></div></body></html>`;
      res.set('Content-Type','text/html; charset=utf-8');
      return res.status(200).send(html);
    }

    // 既存のAPI互換: JSONで202を返す
    try {
      return res.status(202).json({ status: "accepted", message: "週次お出かけプラン生成をバックグラウンドで開始しました。", userId });
    } catch (_) { return; }
  });

// =================================================================
// アプリ（onCall）からの実行
// =================================================================
exports.generatePlansOnCall = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 540, memory: "2GB", secrets: ["GOOGLE_API_KEY", "GOOGLE_CSE_ID"] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "認証が必要です。");
    }
    const userId = context.auth.uid;
    const userRef = admin.firestore().collection("users").doc(userId);
    await userRef.set({ planGenerationStatus: "in_progress" }, { merge: true });

    console.log("--- アプリから受信したデータ ---", JSON.stringify(data, null, 2));

    const { location, interests, maxResults, dateRange } = data;
    if (!location || !interests) {
      throw new functions.https.HttpsError("invalid-argument", "地域と興味は必須です。");
    }

    (async () => {
      try {
        const searchOptions = {
          homeAddress: location,
          interests,
          transportMode: "car", // v7.6: 常に車に固定
          maxResults,
          dateRange,
        };
        const { finalPlans, allCandidateUrls } = await generatePlansForUser(userId, searchOptions);
        await weeklyUtils.savePlansToFirestore(finalPlans || [], userId);
        try {
          await admin.firestore().collection('users').doc(userId)
            .set({ allCandidateUrls: allCandidateUrls || [] }, { merge: true });
        } catch (e) {
          console.warn('[meta-save] allCandidateUrls 保存に失敗:', e && e.message ? e.message : e);
        }
      } catch (error) {
        console.error(`[バックグラウンドエラー] UserID: ${userId}`, error);
        await userRef.set({ planGenerationStatus: "completed" }, { merge: true });
      }
    })();

    return { status: "processing_started" };
  });

// =================================================================
// メイン処理フロー
// =================================================================
async function generatePlansForUser(userId, userData) {
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
    return { finalPlans: [], allCandidateUrls: [] };
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
    return { finalPlans: [], categorizedAlternatives: null, allCandidateUrls: allUrlsArray };
  }

  const selectionResult = await agents.agentFinalSelector(validCandidates, userData, userData.maxResults);
  if (!selectionResult?.final_candidates?.length) {
    return { finalPlans: [], categorizedAlternatives: null, allCandidateUrls: allUrlsArray };
  }

  const finalCandidates = selectionResult.final_candidates;
  console.log(`> ★★★ ${finalCandidates.length}件の有効な候補を確保 ★★★`);

  const finalPlans = await agents.agentFinalPlanner(finalCandidates, userData);

  // 画像URL補完（og:image → 最初の<img> → Google画像検索）
  const patchedPlans = await Promise.allSettled((finalPlans || []).map(plan => (async () => {
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
    } catch (_) { /* ベストエフォート */ }
    try {
      const q = `${plan.location?.name || ''} ${plan.eventName}`.trim();
      const fallback = await weeklyUtils.toolGoogleImageSearch(q);
      if (fallback) plan.imageUrl = fallback;
    } catch (_) { /* ignore */ }
    return plan;
  })()));
  const patchedPlansOk = patchedPlans
    .filter(s => s.status === 'fulfilled')
    .map(s => s.value);

  return { finalPlans: patchedPlansOk, categorizedAlternatives: null, allCandidateUrls: allUrlsArray };
}

// =================================================================
// プレビュー用: 保存済みプランをHTMLで返す
// =================================================================
exports.previewWeeklyPlans = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 120, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    try {
      const db = admin.firestore();
      const userId = (req.query.userId || "test-user-01").toString();

      // plans 読み込み
      const userRef = db.collection("users").doc(userId);
      const plansSnap = await userRef
        .collection("suggestedPlans")
        .orderBy("createdAt", "desc")
        .get();
      const plans = plansSnap.docs.map((d) => d.data());

      // ロケーション（なければ'不明'）
      const userDoc = await userRef.get();
      const location = userDoc.exists
        ? userDoc.get("homeAddress") || userDoc.get("broadSearchArea") || "不明"
        : "不明";

      // 代替案やデバッグURLは現状未保存のため空配列
      const categorizedAlternatives = [];
      const allCandidateUrls = userDoc.exists
        ? userDoc.get("allCandidateUrls") || []
        : [];

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
  });
// =================================================================
// 生成ステータス取得API: { status: 'in_progress' | 'completed' }
// =================================================================
exports.getPlanStatus = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 60, memory: "256MB" })
  .https.onRequest(async (req, res) => {
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
  });