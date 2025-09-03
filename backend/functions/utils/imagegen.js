const { VertexAI } = require('@google-cloud/vertexai');
const { Storage } = require('@google-cloud/storage');
const path = require('path');
// Requires: npm i google-auth-library @google-cloud/vertexai @google-cloud/storage

// Cloud Storage
const storage = new Storage();
const BUCKET = (() => {
  try {
    if (process.env.FIREBASE_CONFIG) {
      const cfg = JSON.parse(process.env.FIREBASE_CONFIG);
      if (cfg.storageBucket) return cfg.storageBucket;
    }
  } catch (_) { /* ignore */ }
  const pid =
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    'aibabyapp-abeae';
  return `${pid}.appspot.com`;
})();

// Vertex AI (Imagen3) 設定
const vertex = new VertexAI({
  project:
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT,
  location: 'us-central1', // 画像生成は us-central1 が安定
});
const MODEL = 'imagen-3.0-generate-002'; // Imagen 3.0 Generate 002
const TEXT_MODEL = 'gemini-1.5-flash-001';

// Safety挙動の切替（0で緩める）。例: set IMAGEGEN_STRICT=0
const STRICT_IMAGE_SAFETY = String(process.env.IMAGEGEN_STRICT || '1') !== '0';

function stripMarkdown(md = '') {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\!\[[^\]]*\]\([^\)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^\)]*\)/g, ' ')
    .replace(/[#>*_~`>-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function makeVisualBriefWithGemini(article) {
  try {
    const gen = vertex.getGenerativeModel({ model: TEXT_MODEL });
    const bodyText = stripMarkdown(String(article?.body || '')).slice(0, 2000);
    const title = article?.title || '';
    const tags = Array.isArray(article?.tags) ? article.tags.join(', ') : '';
    const monthAge = Number.isFinite(article?.monthAge) ? `対象月齢: 生後${article.monthAge}か月` : '';

    const prompt = [
      '次の育児記事の内容を元に、ヒーロー画像生成のための「視覚ブリーフ」をJSONで作成してください。',
      '日本語で、短く簡潔に。必ず以下のキーを含めてください。',
      '{',
      '  "scene": "主要なシーン(例: 静かな寝室で赤ちゃんの睡眠サイン)",',
      '  "objects": ["主要モチーフ1", "主要モチーフ2"],',
      '  "mood": "安心・温かい など",',
      '  "colors": ["やさしい色1", "やさしい色2"],',
      '  "avoid": ["避ける要素(顔のクローズアップ、テキスト、ロゴ等)"]',
      '}',
      '',
      `タイトル: ${title}`,
      `タグ: ${tags}`,
      monthAge,
      `本文(抜粋): ${bodyText}`,
    ].filter(Boolean).join('\n');

    const resp = await gen.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
    const txt = resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonStart = txt.indexOf('{');
    const jsonEnd = txt.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const obj = JSON.parse(txt.slice(jsonStart, jsonEnd + 1));
      return obj;
    }
    return null;
  } catch (e) {
    console.warn('[imagegen] visual brief generation failed, fallback to simple prompt:', e?.message || e);
    return null;
  }
}

async function translateJaToEn(textJa) {
  try {
    const gen = vertex.getGenerativeModel({ model: TEXT_MODEL });
    const prompt = `Translate the following Japanese prompt into concise, natural English for an image generation model. Keep constraints and enumerations.\n\n-----\n${textJa}`;
    const resp = await gen.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
    const out = resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return out || textJa; // fallback to JA if empty
  } catch (_) {
    return textJa; // network or quota fallback
  }
}

function sanitizePromptForSafety(text) {
  try {
    let t = String(text || '');
    if (STRICT_IMAGE_SAFETY) {
      // 子ども/赤ちゃん/人など人物連想ワードを除去・弱体化
      t = t.replace(/赤ちゃん|乳児|子ども|子供|幼児|新生児|ベビー|baby|child|kids?|人間|人物|顔|手|体|肌|人/gi, '');
      // 月齢表現の除去
      t = t.replace(/生後\s*\d+\s*か?月/g, '').replace(/月齢/g, '');
      // 直接的人体描写を避ける旨を強調
      t += '\n厳守: 人物・人型・顔・手・肌色の領域・シルエットを一切含めない。静物アイコンのみ。';
    }
    return t;
  } catch (_) { return String(text || ''); }
}

async function buildPromptFromArticle(article) {
  const title = article?.title || '育児記事のヒーロー画像';
  const tags = Array.isArray(article?.tags) ? article.tags.join(', ') : '';
  const body = sanitizePromptForSafety(stripMarkdown(String(article?.body || '')).slice(0, 800));

  if (!STRICT_IMAGE_SAFETY) {
    // Story cues derived from article content
    const { setting, timeOfDay, actionHint } = (function deriveStoryHints(a) {
      try {
        const text = `${a?.title || ''} ${Array.isArray(a?.tags) ? a.tags.join(' ') : ''} ${String(a?.body || '')}`;
        const t = text.toLowerCase();
        let setting = 'a cozy home interior';
        let timeOfDay = 'daytime soft light';
        let actionHint = 'a gentle caregiving moment';
        if (/(睡眠|寝|眠|就寝|夜|ねんね)/.test(text)) { setting = 'a calm bedroom'; timeOfDay = 'evening warm light'; actionHint = 'soothing to sleep'; }
        else if (/(離乳|食|栄養|食事|ミルク)/.test(text)) { setting = 'a kitchen or dining table'; timeOfDay = 'daytime natural light'; actionHint = 'feeding time'; }
        else if (/(外気浴|散歩|外出|公園|ベビーカー)/.test(text)) { setting = 'a small park or balcony'; timeOfDay = 'morning light breeze'; actionHint = 'going for a short walk'; }
        else if (/(発達|遊び|運動|知育|おもちゃ)/.test(text)) { setting = 'a living room play area with a soft mat'; timeOfDay = 'daytime soft light'; actionHint = 'playing with simple toys'; }
        else if (/(安全|予防|事故|ケガ|怪我|対策)/.test(text)) { setting = 'a tidy living room with childproofed furniture'; timeOfDay = 'daytime'; actionHint = 'carefully checking the environment'; }
        else if (/(小児科|受診|病院|診察|検診|医療)/.test(text)) { setting = 'a pediatric clinic waiting area'; timeOfDay = 'daytime'; actionHint = 'waiting calmly with a toy'; }
        return { setting, timeOfDay, actionHint };
      } catch (_) { return { setting: 'a cozy home interior', timeOfDay: 'daytime soft light', actionHint: 'a gentle caregiving moment' }; }
    })(article);
    const motifs = pickSafeMotifsFromArticle(article);
    return `
You are an illustrator. Create a warm, **non‑photorealistic** hero illustration that suggests a **small story** related to the parenting article.

- Style: storybook illustration, soft watercolor texture, subtle paper grain, hand‑drawn feel; flat shapes with gentle gradients; **no photorealism**.
- People: allowed (baby + caregiver) but **stylized/simplified** only; anonymized faces (simple dots/lines), no real person likeness, no logos or text.
- Narrative: capture a **micro‑scene** that implies warmth, care, and everyday parenting life — ${actionHint}, in ${setting}, ${timeOfDay}. Suggest **gentle motion** (e.g., swaying mobile, drifting curtain) without depicting action blur.
- Composition: clear focal point; use **layered depth** (foreground / midground / background) to draw the viewer in; generous whitespace so a title could sit above.
- Layout: 16:9 wide banner suitable for an article cover.

# Article meta
- Title: ${title}
- Tags: ${tags}
- Theme objects (suggestions): ${motifs.join(', ')}

# Excerpt
${body}
`;
  }

  return `
あなたは優秀なビジュアルアーティストです。以下の育児記事の内容に基づき、
**子育てを象徴する静物・アイコン・ピクトグラム**のみで構成されたヒーロー画像を生成してください。
**人物（人型・顔・手など身体の一部、肌色の大きな領域）を一切描かない**でください。人のシルエットや子どもを想起させる抽象人型も禁止です。
記事の主要テーマ（離乳食・睡眠・発達など）に関連する **物** のモチーフを優先してください（例：スプーン・小鉢・雲や星のアイコン・木馬・ガラガラ・アルファベットブロック など）。
**写真風は避け**、やさしい配色の **ミニマルなイラスト/フラットベクター** で、安全で安心感のある表現にしてください。
レーシングカーや風景のみの画像、文字やロゴ、ウォーターマークは絶対に使わないでください。英字・数字・記号など「文字に見える要素」も入れないでください。

# 記事メタ
- タイトル: ${sanitizePromptForSafety(title)}
- タグ: ${sanitizePromptForSafety(tags)}
- 対象: 一般

# 記事の要点（抜粋）
${body}

# 厳守ルール（重要）
- **人物（赤ちゃん・子ども・大人）を一切描かない**
- 顔・手・身体の一部や肌色の大きな領域を描かない
- 文字(タイポ)、ロゴ、透かしは入れない
- 危険な描写、医療行為の誤解を招く表現は禁止
- **静物・アイコン・シンボルのみ**で構成し、読み物のカバーに合うシンプルな構図

# スタイル
- フラットアイコン / ベクター / シンボリック
- 柔らかい光、安心感、余白を活かす
- 横長 16:9、1408x768（モデル既定の解像度）
  `;
}

function pickSafeMotifsFromArticle(article) {
  const motifs = new Set();
  const text = `${article?.title || ''} ${Array.isArray(article?.tags) ? article.tags.join(' ') : ''} ${String(article?.body || '')}`;
  const t = text.toLowerCase();
  const add = (arr) => arr.forEach(x => motifs.add(x));
  if (/離乳|食|栄養|食事/.test(t)) add(['spoon', 'small bowl', 'steamed rice icon', 'carrot icon']);
  if (/睡眠|寝|眠|夜|就寝|昼寝/.test(t)) add(['crescent moon', 'stars', 'pillow icon']);
  if (/発達|遊び|運動|知育|学習/.test(t)) add(['wooden blocks', 'puzzle piece', 'stacked cubes without letters']);
  if (/安全|予防|注意|事故|ケガ|怪我/.test(t)) add(['shield icon', 'checkmark', 'padlock']);
  if (/小児科|受診|病院|診察|医療|検診/.test(t)) add(['stethoscope icon', 'hospital cross symbol']);
  if (/頭|形|向き|向き癖|頭の形/.test(t)) add(['geometric shapes', 'helmet icon']);
  // 何も拾えない時のデフォルト
  if (motifs.size === 0) add(['stacked cubes without letters', 'stars', 'shield icon']);
  return Array.from(motifs);
}

function buildObjectOnlyPrompt(article) {
  const motifs = pickSafeMotifsFromArticle(article);
  const palette = 'soft pastel colors, high contrast, generous whitespace';
  return [
    'Create a flat vector hero image composed ONLY of safe objects/icons. NO people, NO human-like silhouettes, NO faces, NO hands, NO skin tones.',
    `Objects to include (arranged simply): ${motifs.join(', ')}`,
    'Style: minimalist icons, rounded shapes, clean lines, subtle gradients, friendly and calm tone.',
    'No text, no letters, no numbers, no labels/signage, no logos, no watermark.',
    `Palette: ${palette}.`,
    'Layout: 16:9 wide banner composition suitable for an article cover.',
  ].join('\n');
}

async function generateImageBytes(prompt, { language = 'en', aspectRatio = '16:9', sampleCount = 1 } = {}) {
  const { GoogleAuth } = require('google-auth-library');
  const projectId =
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error('PROJECT_ID is not resolved from environment');

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();

  // Imagen3 REST endpoint
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/${MODEL}:predict`;

  // Official REST schema for Imagen 3.0 Generate 002
  // NOTE: negativePrompt is **not supported** on imagen-3.0-generate-002
  const parameters = {
    sampleCount,
    aspectRatio,
    language,            // Imagen 3 は language サポートあり（ja 直投げ）
    enhancePrompt: true, // 002 では強化を有効にして関連性を上げる（必要に応じて後で AB）
    includeRaiReason: true,
    includeSafetyAttributes: true,
    outputOptions: { mimeType: 'image/jpeg', compressionQuality: 82 },
    // seed は addWatermark=true の場合は無効。
  };
  if (STRICT_IMAGE_SAFETY) {
    parameters.personGeneration = 'dont_allow';
  }

  const body = {
    instances: [{ prompt }],
    parameters,
  };

  // デバッグログ（本文先頭だけ、PIIを避ける）
  console.info('[imagegen] request prompt.head=', String(prompt).slice(0, 120));

  const res = await client.request({ url, method: 'POST', data: body });

  if (!res?.data?.predictions?.length) {
    console.error('[imagegen] empty predictions', JSON.stringify(res?.data || {}, null, 2));
  }

  // 返却形式の互換処理
  const pred = res?.data?.predictions?.[0] || {};
  const b64 = pred.bytesBase64Encoded; // per docs
  if (!b64) {
    // レスポンス全体を追加ログ（サイズ注意・1回分のみ）
    console.error('[imagegen] full response for empty predictions', JSON.stringify(res?.data || {}, null, 2));
    throw new Error('image generation failed: empty predictions (see logs for includeRaiReason)');
  }
  return Buffer.from(b64, 'base64');
}

async function saveToGcs(buffer, destPath, { cacheSeconds = 300 } = {}) {
  const file = storage.bucket(BUCKET).file(destPath);
  await file.save(buffer, {
    contentType: 'image/jpeg',
    resumable: false,
    public: true,
    // Cacheは軽め（更新の可能性あり）
    metadata: { cacheControl: `public, max-age=${cacheSeconds}` },
  });
  // 公開URL（Signed URLは不要）
  const publicUrl = `https://storage.googleapis.com/${BUCKET}/${destPath}`;
  return { publicUrl };
}

/**
 * 記事1本のヒーロー画像を生成してStorageへ保存し、URL等のメタを返す
 * @param {string} articleId
 * @param {object} article Firestoreに保存されている記事オブジェクト
 * @returns {{url: string, alt: string, source: string}}
 */
async function ensureArticleHeroImage(articleId, article) {
  console.info('[imagegen] STRICT_IMAGE_SAFETY =', STRICT_IMAGE_SAFETY);
  const jaPrompt = await buildPromptFromArticle(article);
  let bytes;
  try {
    bytes = await generateImageBytes(jaPrompt, { language: 'ja' });
  } catch (e1) {
    try {
      // Fallback 2: policy-dependent
      if (STRICT_IMAGE_SAFETY) {
        const enPrompt = buildObjectOnlyPrompt(article);
        console.info('[imagegen] fallback to object-only prompt');
        bytes = await generateImageBytes(enPrompt, { language: 'en' });
      } else {
        const enPrompt = `Storybook watercolor‑style illustration banner (non‑photorealistic) with a stylized baby and caregiver; simplified/anonymized faces; layered depth; gentle motion cues; no logos or text; 16:9.`;
        console.info('[imagegen] fallback to illustrated-people prompt');
        bytes = await generateImageBytes(enPrompt, { language: 'en' });
      }
    } catch (e2) {
      // Fallback 3: Minimal neutral composition
      const minimal = STRICT_IMAGE_SAFETY
        ? [
            'Flat minimalist vector hero image. ONLY safe icons: spoon, small bowl, stars, shield icon.',
            'No people. No silhouettes. No faces or hands. No skin tones.',
            'Soft pastel colors. 16:9 layout.',
          ].join('\n')
        : [
            'Friendly non-photorealistic illustration banner that suggests a small story related to parenting (micro-scene). No logos or text. Pastel colors. 16:9.',
          ].join('\n');
      console.info('[imagegen] fallback to minimal prompt');
      bytes = await generateImageBytes(minimal, { language: 'en' });
    }
  }
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); // yyyymmddHHMMss
  const dest = path.posix.join('images', 'articles', articleId, `hero_${ts}.jpg`);
  const { publicUrl } = await saveToGcs(bytes, dest, { cacheSeconds: 300 });
  console.info('[imagegen] generated bytes=', bytes.length, 'dest=', dest);
  return {
    url: `${publicUrl}?v=${Date.now()}`,
    alt: article?.title || '記事画像',
    source: 'imagen-3.0-generate-002',
  };
}

module.exports = {
  ensureArticleHeroImage,
  buildPromptFromArticle,
};
