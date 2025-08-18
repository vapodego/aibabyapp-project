/**
 * =================================================================
 * 週次プランニング A2 (weeklyPlanner_a2.js) - Address必須版
 * - コール1: Core JSON（探索/抽出；最小構成 + address を必須化）
 * - コール2: Core JSON → 完成HTML（整形専用）
 * - 外部API不使用。参照URL/写真はCoreに含めず、HTML側はCoreだけで簡潔に組版。
 * =================================================================
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const OpenAI = require("openai");

// ---------- OpenAI 初期化 ----------
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

// ---------- Firebase Admin 初期化 ----------
try {
  if (!admin.apps.length) admin.initializeApp();
} catch (e) {
  console.error("Firebase Admin 初期化エラー:", e);
}

/** =================================================================
 * Core JSON のスキーマ（最小＋address必須；件数は1〜2）
 *  - この環境のバリデータは「propertiesに出したキーはrequiredに全列挙」が必要。
 *  - そのため items.properties は address を含む5項目のみ、required にも5項目を全列挙。
 * ================================================================= */
const coreSchema = {
  name: "WeeklyEventCore",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      home_address: { type: "string" },
      date_range:   { type: "string" },     // "YYYY-MM-DD〜YYYY-MM-DD"
      items: {
        type: "array",
        minItems: 1,
        maxItems: 2,                        // 安定運用のため 1〜2 件
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title:        { type: "string" },
            period:       { type: "string" },
            venue_name:   { type: "string" },
            address:      { type: "string" },       // ★ 必須
            official_url: { type: "string" }
          },
          required: ["title","period","venue_name","address","official_url"]
        }
      }
    },
    required: ["home_address","date_range","items"]
  },
  strict: true
};

// =================================================================
// 手動テスト用エンドポイント（ローカル/本番）
// =================================================================
exports.runWeeklyPlansA2Manually = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .https.onRequest(async (req, res) => {
    const db = admin.firestore();
    console.log("【A2】Core→HTML 2段構えプラン生成を開始");

    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) return res.status(404).send("対象ユーザーが見つかりません。");
    const userDoc = usersSnapshot.docs[0];
    const user = userDoc.data();
    if (!user.homeAddress) return res.status(400).send("homeAddress がありません。");

    // 期間：今日〜14日
    const today = new Date();
    const twoWeeks = new Date(); twoWeeks.setDate(today.getDate() + 14);
    const fmtISO = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const dateRangeIso = `${fmtISO(today)}〜${fmtISO(twoWeeks)}`;
    const docId = fmtISO(today).replace(/-/g,"");

    try {
      // ===== コール1：Core JSON（探索/抽出；address必須）=====
      const promptCore = buildCorePrompt(user.homeAddress, dateRangeIso, user.interests);
      const core = await fetchCorePlanJSON(promptCore);
 
try {
  console.log("【A2/Core JSON レスポンス】\n" + JSON.stringify(core, null, 2));
} catch (e) {
  console.warn("Core JSON のログ出力に失敗:", e);
}

      // Core を Firestore 保存（監査/再レンダリング用）
      await db.collection("users").doc(userDoc.id)
        .collection("weekly_events").doc(docId)
        .set({
          created_at: (admin.firestore?.Timestamp?.now?.() ?? new Date()),
          home_address: core.home_address,
          date_range: core.date_range,
          items: core.items
        }, { merge: true });

      // ===== コール2：HTMLレンダリング（整形専用）=====
      const html = await renderHtmlFromCore(core);

      res.status(200).send(html);
      return;

    } catch (err) {
      console.error("[A2] error:", err?.response?.data || err);
      if (!res.headersSent) res.status(500).send(`A2エラー: ${err.message}`);
    }
  });

// =================================================================
// コール1：Core JSON 取得（Responses API / json_schema）
// =================================================================
async function fetchCorePlanJSON(promptCore) {
  if (!openai) throw new Error("OpenAI client not initialized.");

  const REQUEST_TIMEOUT_MS = 500_000; // 90秒で切ってフォールバック
  const models = ["gpt-5", "gpt-5-mini"]; // だめなら mini へ

  const formatArgs = {
    text: {
      verbosity: "low", // 出力量を絞る
      format: {
        type: "json_schema",
        name: coreSchema.name,               // 一部環境で必須
        schema: coreSchema.schema,
        strict: true
      }
    },
    reasoning: { effort: "medium" }
  };

  const withTimeout = (args) => Promise.race([
    openai.responses.create(args),
    new Promise((_, rej) => setTimeout(() => rej(new Error("request-timeout")), REQUEST_TIMEOUT_MS))
  ]);

  let lastErr;
  for (const model of models) {
    try {
      const resp = await withTimeout({
        model,
        input: [
          { role: "system", content: [
            "出力は必ず指定スキーマのJSONのみ。前置き/説明は書かない。",
            "URLや住所は、でっち上げ禁止。確信が無い場合は次の方針に従う：",
            " - address は空文字ではなく、`住所未記載（公式未掲載）` と明記する（※スキーマ必須のため）。",
            " - official_url は不明なら出力を中止し、その候補を省く（候補件数は1〜2件で足りる）。",
            "冗長なテキストを避け、値の正確性を優先。"
          ].join("\n") },
          { role: "user", content: promptCore }
        ],
        ...formatArgs
      });

      const txt = (resp.output_text || "").trim();
      if (!txt) throw new Error("no output_text");
      return JSON.parse(txt);

    } catch (e) {
      lastErr = e;
      const msg = (/request-timeout/.test(e?.message)) ? "request timeout"
        : (e?.response?.data?.error?.message || e?.message || String(e));
      console.warn(`[A2/Core] model=${model} failed:`, msg);
      // 次モデルへフォールバック
    }
  }
  throw lastErr;
}

// =================================================================
/** コール2：HTML レンダリング（Core→完成HTML; プレーンテキスト）
 *  - Coreに存在しない新規情報/URLは作らない。
 *  - address は Core の値をそのまま表示（"住所未記載（公式未掲載）" の可能性を許容）。
 */
// =================================================================
async function renderHtmlFromCore(coreJson) {
  if (!openai) throw new Error("OpenAI client not initialized.");

  const REQUEST_TIMEOUT_MS = 90_000;
  const withTimeout = (args) => Promise.race([
    openai.responses.create(args),
    new Promise((_, rej) => setTimeout(() => rej(new Error("request-timeout")), REQUEST_TIMEOUT_MS))
  ]);

  const promptHtml = buildHtmlPrompt(coreJson);

  const resp = await withTimeout({
    model: "gpt-5-mini", // 整形専用は mini で十分＆高速
    input: [
      { role: "system", content: "出力はHTML文字列のみ（前後に余計な文字なし）。" },
      { role: "user", content: promptHtml }
    ],
    text: { verbosity: "medium" },
    reasoning: { effort: "low" }
  });

  const html = (resp.output_text || "").trim();
  if (!html.startsWith("<")) throw new Error("invalid HTML output");
  return html;
}

// =================================================================
// プロンプト生成（Core / HTML）
// =================================================================
function buildCorePrompt(homeAddress, dateRangeIso, interests) {
  const interestsText = Array.isArray(interests) ? interests.join("、")
    : (typeof interests === "string" ? interests : "子連れ・幼児向け");

  return `
出発地: ${homeAddress}
対象期間: ${dateRangeIso}
対象: 小さな子供がいる家族が1日楽しめること
移動: 車/公共交通の60分圏
件数: 5件（厳選）
優先: 期間限定のイベント/アクティビティ
参照URL: 収集・判断に使ったURLを**すべて**記録する（後述のHTMLの「参考リンク一覧」に列挙）
興味関心: ${interestsText}

# 必須出力（指定スキーマに一致）
- home_address, date_range
- items[].title / period / venue_name / address / official_url（この5つは必須）
- でっち上げ禁止。住所が公式に見つからなければ \`住所未記載（公式未掲載）\` と書く（空文字は不可）。
- official_url が見つからない候補は出さない。
- 各イベント
    - タイトル、期間、場所（住所可）、簡易アクセス（車/公共交通の目安）
    - 公式サイトボタン（aタグ）
    - イベントの概要を1パラグラフで。1イベントに複数アクティビティがある場合は、それらを記載して。
    - 「このプランが最適な理由」「赤ちゃん向け設備（テーブルで表示）」「持ち物・注意点（テーブルで表示）」
    - 「1日のモデルスケジュール」は軽量（5〜8行）。時刻は目安で良い。
  - それぞれの項目に**「参考リンク一覧」**として、参照に使ったURLを**重複排除**して

`;
}

function buildHtmlPrompt(coreJson) {
  return `
あなたはHTML整形担当です。以下の Core(JSON) に**含まれるテキストのみ**を使い、完成HTMLを1つだけ出力してください。
追加の情報探索や推測は一切行わず、**文言はできるだけ逐語（原文のまま）**で表示します。
- Tailwind（CDN）を読み込み、白背景＋カードで読みやすく。
- 各イベントカードには **title / period / venue_name / address / official_url** を**そのまま**表示。
- 文章を要素に分ける場合は、**語句を変えず**に箇条書きに区切るのは可（並び替えは可、**言い換えは不可**）。
- Core に存在しない項目（写真・追加URL 等）は**作らない／書かない**。
- 住所が「住所未記載（公式未掲載）」なら、その文字列をそのまま表示。
- 「参考リンク一覧」は **official_url のみ**を列挙（重複排除）。他のURLは追加しない。
- スケジュール欄は**簡易**でよい。Coreに無い具体名は出さず、一般語（例:「移動」「休憩」「昼食」）のみ可。
- 出力は**HTML文字列のみ**（前後に余計な文字なし）。

# Core(JSON)
${JSON.stringify(coreJson)}
`;
}
