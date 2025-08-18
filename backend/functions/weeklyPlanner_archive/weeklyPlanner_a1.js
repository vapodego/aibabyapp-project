/**
 * =================================================================
 * 週次プランニング A案 (weeklyPlanner_a1.js)
 * - GPT-5 への 1 回呼び出しで「厳密 JSON + 完成 HTML」を同時生成
 * - 参照URLは HTML 末尾の「参考リンク一覧」にハイパーリンクで全列挙
 * - 外部API（Google Maps 等）は使わず、推定/一般情報で簡易化
 * =================================================================
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const OpenAI = require("openai");

// OpenAI 初期化
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

// Firebase Admin 初期化
try {
  if (!admin.apps.length) admin.initializeApp();
} catch (e) {
  console.error("Firebase Admin 初期化エラー:", e);
}

/** ===== JSONスキーマ（厳密） =====
 * - page_html: 完成HTML（head/body含む）。参照URLは本文末に <ul><li><a href=...>..</a></li>… で列挙。
 * - data: UI/DB用の機械可読データ。items は 3〜5件（可変）。schedule は軽め（5〜8行）OK。
 */
const responseSchema = {
  name: "WeeklyEventResult",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      home_address: { type: "string" },
      date_range:   { type: "string" },  // "2025-08-14〜2025-08-28"
      page_html:    { type: "string" },  // 完成HTML
      data: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            minItems: 3,
            maxItems: 5,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title:        { type: "string" },
                period:       { type: "string" },
                venue_name:   { type: "string" },
                address:      { type: "string" },
                official_url: { type: "string" },
                ref_urls:     { type: "array", items: { type: "string" } }, // 参照に使ったURL（公式以外も含む）
                photo_urls:   { type: "array", items: { type: "string" } },
                access_note:  { type: "string" },   // 車/公共交通の目安（推定OK）
                tips_md:      { type: "string" },   // 見どころ/持ち物/ベビー設備 等（Markdown）
                schedule: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      time: { type: "string" },     // "09:00" 等（目安）
                      name: { type: "string" },     // "出発" / "到着" / "イベント" / "ランチ" など
                      note: { type: "string" }
                    },
                    required: ["time","name","note"]
                  }
                }
              },
         required: [
              "title",
               "period",
               "venue_name",
               "address",
               "official_url",
               "ref_urls",
               "photo_urls",
               "access_note",
               "tips_md",
               "schedule"
                         ]
            }
          }
        },
        required: ["items"]
      }
    },
    required: ["home_address","date_range","page_html","data"]
  },
  strict: true
};

// ================================================================
// 手動テスト用エンドポイント（ローカル & 本番）
// ================================================================
exports.runWeeklyPlansA1Manually = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .https.onRequest(async (req, res) => {
    const db = admin.firestore();
    console.log("【A1】GPT-5単発プラン生成を開始");

    // 任意: users コレクションの先頭ユーザーを使う（既存設計に準拠）
    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) return res.status(404).send("対象ユーザーが見つかりません。");

    const userDoc = usersSnapshot.docs[0];
    const userId = userDoc.id;
    const user = userDoc.data();
    if (!user.homeAddress) return res.status(400).send("homeAddress がありません。");

    try {
      // 期間：今日〜14日
      const today = new Date();
      const twoWeeks = new Date(); twoWeeks.setDate(today.getDate() + 14);
      const fmtISO = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      const dateRangeIso = `${fmtISO(today)}〜${fmtISO(twoWeeks)}`;

      const prompt = buildPromptA1(user.homeAddress, dateRangeIso, user.interests);

      // —— GPT-5 1コール：仕様揺れに強い呼び出し（text.format の差異を吸収）——
      const data = await callGpt5OneShotJSON(prompt, responseSchema);

       // まず Firestore 保存（失敗しても 500 を返したい場合は try/catch をこのブロックに）
 const docId = fmtISO(today).replace(/-/g, "");
 await db.collection("users").doc(userId).collection("weekly_events").doc(docId)
   .set({
     created_at: (admin.firestore?.Timestamp?.now?.() ?? new Date()),
     home_address: data.home_address,
     date_range: data.date_range,
     items: data.data.items
   }, { merge: true });

 // 保存が通ったら 200 を返して終了
 res.status(200).send(data.page_html);
 return;

    } catch (err) {
      console.error("[A1] エラー:", err?.response?.data || err);
      if (!res.headersSent) {
   res.status(500).send(`A1エラー: ${err.message}`);
 }
    }
  });

/**
 * GPT-5 を 1 回だけ呼び出して「厳密JSON」を取得。
 * text.format の仕様差分に対応するため、複数候補を順に試す。
 */
async function callGpt5OneShotJSON(prompt, responseSchema) {
  if (!openai) throw new Error("OpenAI client not initialized.");

  // フォールバック順：まず gpt-5、だめなら gpt-5-mini
  const models = ["gpt-5", "gpt-5-mini"];

  // 一番“怒られにくい” format（今回の環境ログ基準）
  const baseFormat = {
    text: {
      verbosity: "medium",                     // 出力量控えめ
      format: {
        type: "json_schema",
        name: "WeeklyEventResult",             // ← name 必須と言われる環境向け
        schema: responseSchema.schema,         // ← schema 本体
        strict: true
      }
    },
    reasoning: { effort: "low" }            // ご指定どおり Medium
  };

  // 自前タイムアウト（120秒）。timeout したら次モデルへフォールバック。
  const REQUEST_TIMEOUT_MS = 450_000;

  const requestWithTimeout = (args) => Promise.race([
    openai.responses.create(args),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("request-timeout")), REQUEST_TIMEOUT_MS)
    )
  ]);

  let lastErr;
  for (const model of models) {
    try {
      const resp = await requestWithTimeout({
        model,
        input: [
          { role: "system", content: [
            "あなたは日本の地理・育児施設・家族向けイベントに詳しいコンシェルジュです。",
            "必ず指定スキーマのJSONのみを返し、会話文や説明は一切付けないこと。",
            "URLは実在の可能性が高いもののみ。不明なら official/ref_urls から除外する。",
            "出力は簡潔に（過度な説明や長文化を避ける）。"
          ].join("\n") },
          { role: "user", content: prompt }
        ],
        ...baseFormat
      });

      const jsonText = (resp.output_text || "").trim();
      if (!jsonText) throw new Error("No output_text from Responses API.");
      return JSON.parse(jsonText);

    } catch (e) {
      lastErr = e;
      const msg = (/request-timeout/.test(e?.message)) ? "request timeout" :
                  (e?.response?.data?.error?.message || e?.message || String(e));
      console.warn(`[A1] model=${model} failed:`, msg);
      // → 次のモデル（gpt-5-mini）へ
    }
  }
  throw lastErr;
}


/** プロンプト：HTML完成まで作らせる（参照URLは全列挙＆ハイパーリンク） */
function buildPromptA1(homeAddress, dateRangeIso, interests) {
  const interestsText = Array.isArray(interests) ? interests.join("、")
    : (typeof interests === "string" ? interests : "子連れ・幼児向け");

  // テンプレート内のバッククォート(`)は \` にエスケープしてあります
  return `
# 要件
- 出発地: ${homeAddress}
- 対象期間: ${dateRangeIso}（この範囲で開催されるもの）
- 対象: 小さな子供がいる家族が1日楽しめること
- 移動: 車または公共交通、出発地からおおむね60分圏
- 提案数: 1件のみの厳選
- 提案対象: 常設というより期間限定のイベントやアクティビティで特別感があり家族の思い出に残るもの。
- 興味関心（任意）: ${interestsText}
- 参照URL: 収集・判断に使ったURLを**すべて**記録する（後述のHTMLの「参考リンク一覧」に列挙）
- 外部API利用は禁止（Google Maps API など）。アクセス時間や天気等は推定や一般情報で簡易に。

# 出力仕様（厳守）
- **JSONのみ**を返す。スキーマはリクエストの \`json_schema\` に従う（items, page_html 等）。
- \`page_html\` は Tailwind を CDN で読み込み、以下の構成で完成させる：
  - 冒頭に「出発地」と「対象期間」を明示（ユーザーIDは表示不要）。
  - 各イベントはカード表示：（簡潔な文量で）
    - タイトル、期間、場所（住所可）、簡易アクセス（車/公共交通の目安）
    - 公式サイトボタン（aタグ）
    - イベントの概要を1パラグラフで。1イベントに複数アクティビティがある場合は、それらを記載して。
    - 写真は各イベント**最大1枚**（無い場合は省略）
    - 「このプランが最適な理由」「赤ちゃん向け設備（テーブルで表示）」「持ち物・注意点（テーブルで表示）」
    - 「1日のモデルスケジュール」は軽量（5〜8行）。時刻は目安で良い。
  - それぞれの項目に**「参考リンク一覧」**として、参照に使ったURLを**重複排除**して

    <ul><li><a href="..." rel="noopener noreferrer" target="_blank">...</a></li></ul> で列挙
  - すべてのURLは rel="noopener noreferrer" target="_blank" を付与
- デザインは落ち着いた白背景＋カード。見出し/太字/余白で読みやすく。公式ボタンは目立つ色（青/ティール）で1つ。

# データ仕様の注意
- items[].official_url は可能な限り公式サイトのURLを1つ。
- items[].ref_urls は、選定に使ったURL（ポータル/記事等）。架空/壊れたURLは入れない。
- 情報が曖昧な場合は無理に埋めない（空配列/空文字で可）。
- schedule は軽量でよい（例：出発/到着/イベント/ランチ/帰路 など）。

# 返却フィールドの再掲
- home_address, date_range, data.items[…], page_html

# 生成開始
「${homeAddress}」からの家族向けイベントを、${dateRangeIso}に開催されるもので1件のみ、厳選して作成。参照URLは必ず記録してHTML末尾に列挙すること。
`;
}

