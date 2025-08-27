const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
logger.info("[askArticleQuestion] module loaded");

// ---- Stable sentence hashing (duplicate of client/utils) ----
function normalizeForHash(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[、。・:：;；!！?？…「」『』（）()【】\\[\\]`*_>#-]/g, "")
    .trim();
}
function stableIdFor(s) {
  let h = 5381;
  const t = normalizeForHash(s);
  for (let i = 0; i < t.length; i++) {
    h = ((h << 5) + h) ^ t.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

// ---- Google Generative AI (Gemini) setup ----
let useRealGemini = false;
let generativeModel = null;
try {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const apiKey = process.env.GEMINI_API_KEY; // Secret Manager or env
  if (apiKey) {
    const genAI = new GoogleGenerativeAI(apiKey);
    generativeModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    useRealGemini = true;
  }
} catch (e) {
  // SDK not installed yet; we will fallback to dummy
}

// ---- Gemini caller (real if possible; otherwise dummy) ----
async function callGemini({ system, user }) {
  const prompt = [
    system,
    "\n---\n",
    user,
    "\n---\n",
    "出力要件:",
    "- 日本語で、事実ベース・簡潔に。",
    "- 箇条書きは3〜6項目まで。",
    "- 医療判断が必要な場合は受診の目安をガイドとして添える。",
    "- 注意: モデル自身の説明やプロンプトの焼き直しは書かない。",
  ].join("\n");

  if (useRealGemini && generativeModel) {
    try {
      const t0 = Date.now();
      const result = await generativeModel.generateContent(prompt);
      const t1 = Date.now();
      let text = '';
      try {
        text = result.response.text();
      } catch (_) {
        const c = result?.response?.candidates?.[0]?.content?.parts || [];
        text = c.map(p => p?.text).filter(Boolean).join("\n");
      }
      logger.info("gemini-generate ok", { ms: t1 - t0, bytes: text?.length || 0 });
      if (text && typeof text === "string") return text.trim();
    } catch (err) {
      logger.error("gemini-generate-failed", { message: err?.message });
    }
  }

  // Fallback (dummy) if SDK not available or failed
  return [
    "- 文脈に沿って端的に回答します。",
    "- 医療判断が必要な場合は受診の目安を示します。",
    "- 具体的な手順は安全性を優先して提案します。",
  ].join("\n");
}

exports.askArticleQuestion = onCall({ region: "asia-northeast1", timeoutSeconds: 120, memory: "512MiB" }, async (ctx) => {
  const uid = ctx.auth?.uid || null;
  const data = ctx.data || {};
  const { articleId, question, anchor, selection, depth = 1, parentId } = data;
  const depthNum = Number(depth) || 1;

  logger.info("[askArticleQuestion] start", { uid, articleId, depth, depthNum });

  // ---- basic validation ----
  if (!uid) {
    logger.warn("askArticleQuestion unauthenticated", { path: ctx.rawRequest?.path });
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }
  if (!articleId || typeof articleId !== "string") {
    logger.warn("askArticleQuestion invalid-args: articleId", { data });
    throw new HttpsError("invalid-argument", "articleId が不正です。");
  }
  if (!question || typeof question !== "string") {
    logger.warn("askArticleQuestion invalid-args: question", { data });
    throw new HttpsError("invalid-argument", "question が不正です。");
  }

  try {
    const artRef = db.doc(`articles/${articleId}`);
    const artSnap = await artRef.get();
    if (!artSnap.exists) {
      logger.warn("askArticleQuestion article-not-found", { articleId });
      throw new HttpsError("not-found", "対象の記事が見つかりませんでした。");
    }

    const quote = String(selection?.quote || "");
    // depthNum=1 のときだけ本文アンカーを扱う（depth>=2 は selection.quote を復元キーにする）
    const sentenceHash = depthNum === 1 ? (anchor?.sentenceHash || (quote ? stableIdFor(quote) : null)) : null;

    const system = [
      "あなたは育児支援アプリの月齢記事に関するQAアシスタントです。",
      "専門家の監修方針に沿い、断定を避け、誤情報を避け、安全第一で回答します。",
      "医学的判断が必要な場合は\"受診の目安\"として案内します（診断はしない）。",
      "出力はユーザー向けの日本語の回答のみ（プロンプトの説明やポリシー記述は書かない）。",
    ].join("\n");
    const user = [
      quote ? `【参照文】${quote}` : null,
      `【質問】${question}`,
      `【記事本文（一部抜粋）】${String(artSnap.get("body") || "").slice(0, 4000)}`,
    ]
      .filter(Boolean)
      .join("\n");

    logger.info("[askArticleQuestion] calling gemini", { useRealGemini, hasKey: !!process.env.GEMINI_API_KEY, hasHash: !!sentenceHash });
    const answerText = await callGemini({ system, user });

    logger.info("askArticleQuestion building qaDoc", { depth, depthNum, hasSentenceHash: !!sentenceHash, hasQuote: !!quote });
    const qaDoc = {
      question: String(question),
      answer: { text: String(answerText) },
      depth: depthNum,
      parentId: parentId || null,
      selection: quote ? { quote } : null,
      // depth=1 のみ anchor を保存（depth>=2 は null）
      anchor: (depthNum === 1 && sentenceHash)
        ? {
            sentenceHash,
            paragraphIndex: anchor?.paragraphIndex ?? null,
            sentenceIndex: anchor?.sentenceIndex ?? null,
            articleVersion: Number(anchor?.articleVersion ?? artSnap.get("version") ?? 1),
          }
        : null,
      model: "gemini-1.5-flash",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = db.collection(`users/${uid}/articles/${articleId}/qa`).doc();
    await ref.set(qaDoc);

    logger.info("askArticleQuestion saved", { uid, articleId, qaId: ref.id, depth: depthNum });
    return {
      id: ref.id,
      answer: qaDoc.answer,
      depth: depthNum,
      parentId: parentId || null,
      selection: quote ? { quote } : null,
    };
  } catch (err) {
    // If the error is already an HttpsError, rethrow as-is
    if (err instanceof HttpsError) {
      throw err;
    }
    logger.error("askArticleQuestion internal-error", { message: err?.message, stack: err?.stack });
    throw new HttpsError("internal", "サーバー処理に失敗しました。");
  }
});