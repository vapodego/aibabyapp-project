/**
 * ================================================================
 * 週次プラン（非同期ワーカー）: gpt-5 専用 / 1ステージでHTMLまで生成
 * - HTTP: weeklyPlansJob （POST=開始 / GET=状態 or HTML）
 * - Firestore Trigger: onPlannerJobCreate（裏で実行）
 * - 429: rate limit は指数バックオフ、insufficient_quota は即終了
 * ================================================================
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const OpenAI = require("openai");

// Firebase
try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}
const db = admin.firestore();

// OpenAI init
let openai;
try {
  const KEY = functions.config().openai?.key;
  if (KEY) openai = new OpenAI({ apiKey: KEY });
  else console.error("OpenAI APIキー未設定。`firebase functions:config:set openai.key=\"...\"` を実行してください。");
} catch (e) { console.error("OpenAI 初期化失敗:", e); }

// ---- Utils ----
const jstNow  = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
const pad     = (n) => String(n).padStart(2, "0");
const fmtISO  = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };

const nowTs = () => (admin.firestore?.Timestamp?.now?.() ?? new Date());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class InsufficientQuotaError extends Error {
  constructor(msg, original) { super(msg); this.name = "InsufficientQuotaError"; this.original = original; }
}

// ---- HTTP: POST=ジョブ作成 / GET=状態 & HTML ----
exports.weeklyPlansJob = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 60, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    try {
      if (req.method === "POST") {
        // 対象ユーザー（先頭）
        const users = await db.collection("users").get();
        if (users.empty) return res.status(404).json({ error: "対象ユーザーなし" });

        const userDoc = users.docs[0];
        const user = userDoc.data();
        if (!user.homeAddress) return res.status(400).json({ error: "homeAddress 不足" });

        const today = jstNow();
        const dateRangeIso = `${fmtISO(today)}〜${fmtISO(addDays(today, 30))}`;
        const interests = Array.isArray(user.interests) ? user.interests
                        : (user.interests ? [user.interests] : ["子連れ・幼児向け"]);

        const jobRef = await db.collection("planner_jobs").add({
          created_at: nowTs(),
          updated_at: nowTs(),
          status: "pending", // pending → running → done/error
          stage: 0,
          user_id: userDoc.id,
          home_address: user.homeAddress,
          date_range: dateRangeIso,
          interests,
          html: null,
          error: null,
          metrics: { attempts: 0 }
        });

        return res.status(202).json({
          jobId: jobRef.id,
          status: "accepted",
          check: `/asia-northeast1/weeklyPlansJob?jobId=${jobRef.id}`
        });
      }

      if (req.method === "GET") {
        const jobId = String(req.query.jobId || "").trim();
        if (!jobId) return res.status(400).json({ error: "jobId が必要です" });

        const snap = await db.collection("planner_jobs").doc(jobId).get();
        if (!snap.exists) return res.status(404).json({ error: "job not found" });

        const job = snap.data();
        if (req.query.format === "html" && job?.html) {
          res.set("Content-Type", "text/html; charset=utf-8");
          return res.status(200).send(job.html);
        }
        return res.status(200).json({
          jobId,
          status: job.status,
          stage: job.stage,
          error: job.error || null,
          hasHtml: Boolean(job.html),
          metrics: job.metrics || null
        });
      }

      return res.status(405).json({ error: "Method Not Allowed" });
    } catch (e) {
      console.error("weeklyPlansJob error:", e);
      return res.status(500).json({ error: e.message });
    }
  });

// ---- Firestore Trigger: onCreate ----
exports.onPlannerJobCreate = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .firestore.document("planner_jobs/{jobId}")
  .onCreate(async (snap, ctx) => {
    const jobId = ctx.params.jobId;
    try {
      await processJobSingleStage(jobId);
    } catch (e) {
      console.error(`processJobSingleStage(${jobId}) failed:`, e);
    }
  });

// ---- OpenAI 呼び出し（gpt-5専用 / 429耐性）----
async function callOpenAIWithRetries(baseRequest, {
  maxAttempts = 6,
  initialDelayMs = 1200,
  maxDelayMs = 18000,
  jitter = true,
  requestTimeoutMs = 480_000, // ~8分
} = {}) {
  if (!openai) throw new Error("OpenAI client not initialized.");

  const withTimeout = (args) => Promise.race([
    openai.responses.create(args),
    new Promise((_, rej) => setTimeout(() => rej(new Error("request-timeout")), requestTimeoutMs))
  ]);


  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await withTimeout({ ...baseRequest, model: "gpt-5" });
      return resp;
    } catch (err) {
      const status = err?.status;
      const code   = err?.error?.code || err?.code;
      const type   = err?.error?.type || err?.type;
      const msg    = err?.error?.message || err?.message || String(err);

      // 課金枠不足 → 即終了（リトライ無効）
      if (code === "insufficient_quota" || type === "insufficient_quota" || /insufficient[_\s-]?quota/i.test(msg)) {
        throw new InsufficientQuotaError("OpenAI insufficient quota", err);
      }

      // レート制限 → 指数バックオフ
      if (status === 429 || code === "rate_limit_exceeded" || /rate.?limit/i.test(msg)) {
        lastErr = err;
        const base  = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
        const delay = jitter ? Math.round(base * (0.7 + Math.random() * 0.6)) : base;
        console.warn(`[openai][attempt ${attempt}] 429 rate limit: backoff ${delay}ms`);
        await sleep(delay);
        continue;
      }

      // タイムアウト → 控えめに再試行
      if (msg === "request-timeout" && attempt < maxAttempts) {
        lastErr = err;
        const delay = 2000;
        console.warn(`[openai][attempt ${attempt}] timeout: retry in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      // その他は即座に上位へ
      throw err;
    }
  }
  throw lastErr;
}

// ---- ワーカー（1ステージ）----
async function processJobSingleStage(jobId) {
  const jobRef  = db.collection("planner_jobs").doc(jobId);
  const jobSnap = await jobRef.get();
  const job     = jobSnap.data();
  if (!job) throw new Error("job not found");

  const { home_address, date_range, interests } = {
    home_address: job.home_address,
    date_range: job.date_range,
    interests: job.interests || []
  };

  // 実行開始
  await jobRef.set({
    status: "running",
    stage: 1,
    updated_at: nowTs()
  }, { merge: true });

  const interestsText = Array.isArray(interests) ? interests.join("、") : String(interests || "");

  const prompt = `
あなたは「家族向けお出かけプランの調査・整形」を1回で完了させるエージェントです。
web_search_preview ツールを使って **本日から30日以内** の最新公式情報のみを対象に、条件に合うイベントを厳選し、
**単一のHTML文書** を生成してください。言い換えや創作は禁止。公式サイト等に明記された文言を優先します。

# 条件
- 出発地: ${home_address}
- 移動: 車/公共交通の **60分圏**
- 対象: 小さな子供がいる家族が1日楽しめること
- 期間: ${date_range}（本日から30日以内のみ）
- 件数: **最大5件**
- 優先: **期間限定**のイベント/アクティビティ
- 興味関心: ${interestsText}

# 収集と制約
- 検索は web_search_preview を用いること。**SNS単独告知は原則除外**し、自治体・施設・主催の**公式URLを優先**。
- **新しい事実・URL・日付等は作らない／推測しない**。サイトに明記されていない事項は空欄または非表示。
- 同一イベントの重複URLは除外。**実在URLのみ**採用。
- 引用（参考リンク）は**すべての参照URL**を漏れなく列挙。

# 必要項目（各イベント）
- タイトル（正式名・逐語）
- 開催期間（表記そのまま）
- 会場名
- 住所（無ければ「住所未記載（公式未掲載）」）
- 公式URL（クリック可能なリンク）
- 子連れ設備（記載がある場合のみ逐語・箇条書き）

# HTML要件（単一文書 / 余計な文字なし）
- Tailwind CDN を読み込み、container mx-auto max-w-3xl p-6。
- ページ上部ヘッダーに「期間: ${date_range}」「出発地: ${home_address}」。
- 各イベントはカード（rounded-2xl shadow p-6 mb-6）。見出しは font-semibold。
- URLは <a href="..." target="_blank" rel="noopener noreferrer">…</a> に。
- 公式に明記のある画像URLのみ <img> を**最大1枚**（無ければ非表示）。
- テキストは whitespace-pre-line。
- ページ末尾に「参考リンク一覧」: **参照URLすべて**を <ul><li>…</li></ul> で列挙（重複排除）。
`;

  let resp;
    console.log(`[DEBUG] Is OpenAI client initialized? -> ${!!openai}`);

  try {
    resp = await callOpenAIWithRetries({
      tools: [{ type: "web_search_preview" }],
      input: [
        { role: "system", content: "出力はHTML文字列のみ（前後に余計な文字なし）。新規事実の創作・言い換え禁止。" },
        { role: "user", content: prompt }
      ],
      text: { verbosity: "medium" },
      reasoning: { effort: "medium" }
    });
  } catch (e) {
    if (e instanceof InsufficientQuotaError) {
      await jobRef.set({
        status: "error",
        stage: 1,
        error: {
          code: "OPENAI_INSUFFICIENT_QUOTA",
          message: "OpenAIの利用枠不足（Billing/Projectの上限に到達）",
          occurred_at: nowTs()
        },
        updated_at: nowTs()
      }, { merge: true });
      return;
    }
    await jobRef.set({
      status: "error",
      stage: 1,
      error: {
        code: "OPENAI_REQUEST_FAILED",
        message: e?.message || String(e),
        occurred_at: nowTs()
      },
      updated_at: nowTs()
    }, { merge: true });
    throw e;
  }

  const html = (resp?.output_text || "").trim();
  if (!html || !html.startsWith("<")) {
    await jobRef.set({
      status: "error",
      stage: 1,
      error: {
        code: "INVALID_HTML",
        message: "モデル出力がHTMLではありません",
        occurred_at: nowTs()
      },
      updated_at: nowTs()
    }, { merge: true });
    return;
  }

  await jobRef.set({
    status: "done",
    stage: 2,
    html,
    metrics: { attempts: admin.firestore.FieldValue.increment(1) },
    updated_at: nowTs()
  }, { merge: true });
}
