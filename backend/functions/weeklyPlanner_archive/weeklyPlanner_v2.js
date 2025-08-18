/**
 * =================================================================
 * 週次プランニング v2（2段構え / Web検索対応 / 逐語HTML）
 * - Stage1: URL収集（小さく速く / JSON厳格）
 * - Stage2: URL精読→抽出→TailwindでHTML（逐語・非創作）
 * - エンドポイントは従来のまま: runWeeklyPlansV2Manually
 * =================================================================
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const OpenAI = require("openai");

// --- OpenAI 初期化 ---
let openai;
try {
  const OPENAI_API_KEY = functions.config().openai?.key;
  if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  } else {
    console.error("OpenAI APIキーが未設定です。`firebase functions:config:set openai.key=\"...\"` を実行してください。");
  }
} catch (e) {
  console.error("OpenAI 初期化に失敗:", e);
}

// --- Firebase Admin 初期化 ---
try {
  if (!admin.apps.length) admin.initializeApp();
} catch (e) {
  console.error("Firebase Admin 初期化エラー:", e);
}

// =================================================================
// JSON Schema（Stage1用 / 最小必須）
// =================================================================
const urlListSchema = {
  name: "EventUrlList",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      home_address: { type: "string" },
      date_range:   { type: "string" },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title:        { type: "string" },
            period:       { type: "string" },
            official_url: { type: "string" }
          },
          required: ["title","period","official_url"]
        }
      }
    },
    required: ["home_address","date_range","items"]
  },
  strict: true
};

// =================================================================
// エンドポイント：URL収集→HTML化（同じURLで完結）
// =================================================================
exports.runWeeklyPlansV2Manually = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .https.onRequest(async (req, res) => {
    const db = admin.firestore();
    console.log("【v2+】URL収集→精読HTML（2段構え）を開始");

    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) return res.status(404).send("対象ユーザーが見つかりません。");

    const userDoc = usersSnapshot.docs[0];
    const userId = userDoc.id;
    const user = userDoc.data();
    if (!user.homeAddress) return res.status(400).send("homeAddress がありません。");

    // 期間：JSTで今日〜30日後
    const nowJst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
    const in30 = addDays(nowJst, 30);
    const pad = n => String(n).padStart(2, "0");
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const dateRangeIso = `${fmt(nowJst)}〜${fmt(in30)}`;

    try {
      // ===== Stage1: URL収集（短タイムアウト / 厳格JSON）=====
      const promptStage1 = buildStage1Prompt(user.homeAddress, dateRangeIso, user.interests);
      const urlList = await fetchEventUrls(promptStage1);

      // ログ出力（観測性）
      try { console.log("【Stage1/URL収集JSON】\n" + JSON.stringify(urlList, null, 2)); } catch (_){}

      // Firestore保存（任意）
      const docId = fmt(nowJst).replace(/-/g,"");
      await db.collection("users").doc(userDoc.id)
        .collection("weekly_events_v2").doc(docId)
        .set({
          created_at: (admin.firestore?.Timestamp?.now?.() ?? new Date()),
          home_address: urlList.home_address,
          date_range: urlList.date_range,
          items: urlList.items
        }, { merge: true });

      if (!urlList.items?.length) {
        return res.status(200).send("<h1>候補URLが見つかりませんでした</h1>");
      }

      // ===== Stage2: URL精読→抽出→逐語HTML（長め / バッチ処理）=====
      // 5件重い時のため 3+2 に分割
      const items = urlList.items.slice(0, 5);
      const batches = [items.slice(0,3), items.slice(3)];
      let mergedHtml = "";

      for (let i=0; i<batches.length; i++) {
        const batch = batches[i].filter(Boolean);
        if (!batch.length) continue;

        const html = await renderHtmlFromUrls({
          batchItems: batch,
          homeAddress: user.homeAddress,
          dateRangeIso
        });

        mergedHtml = i === 0 ? html : mergeHtmlSafely(mergedHtml, html);
      }

      if (!mergedHtml) throw new Error("HTML生成に失敗しました。");
      return res.status(200).send(mergedHtml);

    } catch (error) {
      console.error("【v2+】エラー:", error?.response?.data || error);
      if (!res.headersSent) res.status(500).send("v2+エラー: " + error.message);
    }
  });

// =================================================================
// Stage1: URL収集（Responses API + web_search_preview + json_schema）
// - 1回のAPIは 90s で見切り（フォールバック余地確保）
// =================================================================
async function fetchEventUrls(promptText) {
  if (!openai) throw new Error("OpenAI client not initialized.");

  const REQUEST_TIMEOUT_MS = 400_000; // ← 短め（URL収集だけ）
  const withTimeout = (args) => Promise.race([
    openai.responses.create(args),
    new Promise((_, rej) => setTimeout(() => rej(new Error("request-timeout")), REQUEST_TIMEOUT_MS))
  ]);

  const models = ["gpt-5", "gpt-5-mini"]; // miniへフォールバック
  const formatArgs = {
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: urlListSchema.name,
        schema: urlListSchema.schema,
        strict: true
      }
    },
    reasoning: { effort: "low" }
  };

  let lastErr;
  for (const model of models) {
    try {
      const resp = await withTimeout({
        model,
        tools: [{ type: "web_search_preview" }],
        input: [
          { role: "system", content:
            "あなたはWebリサーチ担当。最新の公式情報のみを対象に、指定スキーマのJSONだけを返すこと。" +
            "SNS単独告知は除外し、自治体・施設・主催の公式URLを優先すること。重複URLは除外。" },
          { role: "user", content: promptText }
        ],
        ...formatArgs
      });

      const out = (resp.output_text || "").trim();
      if (!out) throw new Error("no output_text");
      return JSON.parse(out);

    } catch (e) {
      lastErr = e;
      console.warn(`[Stage1] model=${model} failed:`, e?.response?.data?.error?.message || e?.message || String(e));
      // 次モデルへ
    }
  }
  throw lastErr;
}

// =================================================================
// Stage2: URL精読 → 抽出 → 逐語HTML（Responses API + web_search_preview）
// - 1回のAPIは長めに許容（関数全体540sに収まるように）
// =================================================================
async function renderHtmlFromUrls({ batchItems, homeAddress, dateRangeIso }) {
  if (!openai) throw new Error("OpenAI client not initialized.");

  const REQUEST_TIMEOUT_MS = 480_000; // ← 長め（精読＆整形）
  const withTimeout = (args) => Promise.race([
    openai.responses.create(args),
    new Promise((_, rej) => setTimeout(() => rej(new Error("request-timeout")), REQUEST_TIMEOUT_MS))
  ]);

  const urls = batchItems.map(x => x.official_url).filter(Boolean);
  try { console.log("【Stage2/対象URL】\n" + urls.join("\n")); } catch (_){}

  const prompt = buildStage2Prompt({ batchItems, homeAddress, dateRangeIso });

  const resp = await withTimeout({
    model: "gpt-5-mini", // 整形専用は mini で高速・十分
    tools: [{ type: "web_search_preview" }],
    input: [
      { role: "system", content:
        "あなたはHTML整形担当。与えられたURL本文のみを根拠に、原文逐語で安全にHTML化する。" +
        "新しい事実/URL/日付の追加や創作は禁止。出力はHTML文字列のみ。" },
      { role: "user", content: prompt }
    ],
    text: { verbosity: "medium" },
    reasoning: { effort: "low" }
  });

  const html = (resp.output_text || "").trim();
  if (!html.startsWith("<")) throw new Error("invalid HTML output");
  return html;
}

// =================================================================
// プロンプト生成
// =================================================================
function buildStage1Prompt(homeAddress, dateRangeIso, interests) {
  const interestsText =
    Array.isArray(interests) ? interests.join("、") :
    (typeof interests === "string" ? interests : "子連れ・幼児向け");

  return `
最新の公式情報のみを対象に、下記条件に合致するイベントの公式URLを厳選して返してください。
web_search_preview ツールを利用し、実在性の高い公式サイトに限定。同一イベントの重複URLは除外。
出力は指定スキーマのJSONのみ。

# 条件
- 出発地: ${homeAddress}
- 移動: 車/公共交通の60分圏
- 対象: 小さな子供がいる家族が1日楽しめること
- 期間: ${dateRangeIso}（本日から30日以内のみ）
- 件数: 最大5件（厳選）
- 優先: 期間限定のイベント/アクティビティ
- 興味関心: ${interestsText}

# 必須（各件）
- title（イベント名）, period（開催期間の表記そのまま）, official_url（公式サイトのみ）
- 公式URLが特定できない候補は除外
`;
}

function buildStage2Prompt({ batchItems, homeAddress, dateRangeIso }) {
  const urlLines = batchItems.map(x => `- ${x.title || ""} :: ${x.official_url}`).join("\n");

  return `
次のURL群の本文のみを根拠に、各イベントの必要項目を逐語で抜き出し、単一のHTML文書を生成してください。
言い換え・要約・新規情報の追加は禁止。入力URL以外を参照しないこと。

# 抽出項目（各イベント）
- タイトル（サイト記載の正式名を逐語）
- 開催期間（表記そのまま）
- 会場名（逐語）
- 住所（記載が無ければ「住所未記載（公式未掲載）」と逐語）
- 公式URL（入力URLそのまま）
- 子連れ設備（授乳室/おむつ台/ベビーカー等）※サイトに明記がある場合のみ逐語列挙。無ければ表示しない。

# HTML要件
- 出力はHTML文字列のみ（前後に余計な文字なし）
- Tailwind CDN を利用。レイアウト: container mx-auto max-w-3xl p-6
- イベントカード: rounded-2xl shadow p-6 mb-6、見出しは font-semibold
- テキストは whitespace-pre-line で原文改行を尊重
- ページ上部ヘッダに「期間: ${dateRangeIso}」「出発地: ${homeAddress}」
- ページ末尾に「参考リンク一覧」：入力URLのみを <ul><li><a href target="_blank" rel="noopener noreferrer"></a></li></ul> で列挙（重複排除）

# 対象URL（これ以外は参照禁止）
${urlLines}
`;
}

// =================================================================
// HTMLマージ（バッチ出力を一つのHTMLに連結）
// - シンプルに <body> 内の main 部分を連結（失敗時は末尾に追記）
// =================================================================
function mergeHtmlSafely(htmlA, htmlB) {
  try {
    // 最低限の連結：htmlB の <body> 内を htmlA の </body> 手前に差し込む
    const bodyA = htmlA.split("</body>");
    const bodyB = htmlB.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyA.length === 2 && bodyB && bodyB[1]) {
      return bodyA[0] + bodyB[1] + "</body>" + (htmlA.endsWith("</html>") ? "" : "</html>");
    }
  } catch (_) {}
  // フォールバック：単純結合
  return htmlA + "\n" + htmlB;
}
