/**
 * =================================================================
 * 週次プランナー用 AIエージェント群 (v2.4: 個別検索対応版)
 * =================================================================
 * - 役割: 各タスクに特化したプロンプトを持つAI関数を定義する。
 * - 変更点: agentBroadEventSearcherを、単一の興味キーワードのみを
 * 受け取るようにシンプル化。複数キーワードでの検索ロジックは
 * 呼び出し元のweeklyPlanner.jsに移行。
 */

const { callGenerativeAi, toolGetHtmlContent } = require('../utils');
const { getAnalysisFromCache, saveAnalysisToCache } = require('../utils/weeklyPlannerUtils');
const _pLimit = require('p-limit');
const pLimit = _pLimit.default || _pLimit; // ESM/CJS 両対応
const limitFetch = pLimit(1);   // HTML取得は外向きスパイクを防ぐため1
const limitLite  = pLimit(3);   // 軽い判定・整形は2〜3
const limitLLM   = pLimit(2);   // LLM呼び出しは2（必要に応じて調整）

const DEEPDIVE_BUDGET_MS = 90_000;

async function agentGeographer(location) {
    const prompt = `
# 役割
あなたは日本の地理に精通した専門家です。ユーザーの入力した場所に基づいて、イベント検索に適した広域の検索エリアを定義し、Google検索クエリの形式で出力してください。

# タスク
1.  **中心となる都道府県の特定**: ユーザーの入力から、中心となる市レベルの都市名を特定します。
2.  **広域検索エリアの定義**: 特定した都市名を基に、車や公共交通機関で60分程度の移動時間で到達できる周辺の主要都市や隣接する都道府県を含む広域の検索エリアを提案します。
3.  **Google検索形式への変換**: 最終的な出力は、必ず各地域名を " OR " で区切った単一のテキスト文字列にしてください。

# ルール
- 出力する地名は、市レベルまたは都道府県レベルとします。市レベルが望ましいです。
- **【最重要】** 最終的な出力文字列では、「市」「区」「県」「都」のような行政区分を示す接尾辞を必ず削除してください。（例：「横浜市」→「横浜」）
- 出力には必ず複数の場所を含めてください。
- 説明や挨拶など、会話的なテキストは一切含めないでください。

# ユーザーの場所
"${location}"`;
    return await callGenerativeAi(prompt, false, "gemini-1.5-flash-latest");
}

/**
 * ★★★ 修正点 ★★★
 * 単一の興味キーワード(singleInterest)を受け取り、それに対応する検索クエリを1つだけ生成するシンプルな関数に変更。
 */
async function agentBroadEventSearcher(searchArea, singleInterest) {
    const interestQuery = singleInterest ? `(${singleInterest})` : '';

    const queryTemplate = `${interestQuery} (親子 OR 子連れ OR 家族 OR 小学生 OR ファミリー OR キッズ OR 赤ちゃん OR こども OR 乳幼児 OR 未就学児) (${searchArea})`;
    
    return Promise.resolve({ query: queryTemplate.trim().replace(/\s+/g, ' ') });
}


async function agentInspector(url, htmlContent, userData) {
    const modelUsed = 'gemini-1.5-flash-latest';
    const PROMPT_SIG = 'v1-inspector-20250821';
    if (htmlContent) {
      const cached = await getAnalysisFromCache(url, htmlContent, { model: modelUsed, promptSig: PROMPT_SIG });
      if (cached) return cached;
    }

    const today = new Date();
    const oneMonthFromNow = new Date(today);
    oneMonthFromNow.setMonth(today.getMonth() + 1);
    const formatDate = (d) => d.toISOString().split('T')[0];
    const targetDateRange = `${formatDate(today)} to ${formatDate(oneMonthFromNow)}`;
    const prompt = `
# 役割
あなたは、細部まで見逃さない meticulous な鑑定士AIです。HTMLコンテンツを分析し、イベントがユーザーの興味に合致し、かつ直近1ヶ月以内に開催されるものかどうかを分類・抽出し、評価してください。

# ユーザープロフィール
${JSON.stringify(userData, null, 2)}

# ターゲット期間
${targetDateRange}の間に開催されるイベントを探してください。現在の年は${today.getFullYear()}年と仮定してください。

# URL
${url}

# HTMLコンテンツ (最初の15000文字)
${htmlContent.substring(0, 15000)}

# 分析ステップ
1.  **分類**: このページは「単一イベント」「リストページ」「無関係」のどれですか？
2.  **抽出 (単一イベントの場合)**: eventName, date, summary, locationを抽出します。「8月20日」のような日付は、現在の年（${today.getFullYear()}年）のものと仮定してください。
3.  **鑑定 (単一イベントの場合)**:
    - イベントはユーザーの興味と一致しますか？
    - **【最重要】**: 抽出した日付は、ターゲット期間（${targetDateRange}）の範囲内ですか？

# 出力形式 (単一のJSONオブジェクトのみ)
# - マッチする「単一イベント」の場合 (興味と日付の両方が一致):
#   {"isValid": true, "isMatch": true, "isListPage": false, "eventName": "...", "date": "...", "summary": "...", "location": {"name": "...", "address": "..."}}
# - マッチしない「単一イベント」の場合 (興味または日付が一致しない):
#   {"isValid": true, "isMatch": false, "reason": "イベントの日付がターゲット期間外です。" or "イベントの種類がユーザーの興味と一致しません。"}
# - 「リストページ」または「無関係」の場合:
#   {"isValid": false, "isMatch": false, "isListPage": true or false}`;
    const result = await callGenerativeAi(prompt, true, modelUsed);
    if (htmlContent && result) {
      await saveAnalysisToCache(url, htmlContent, result, { model: modelUsed, promptSig: PROMPT_SIG, ttlSec: 3 * 24 * 60 * 60 });
    }
    return result;
}

async function agentListPageAnalyzer(urls) {
    const htmlSettled = await Promise.allSettled(
      urls.map((url) => limitFetch(async () => {
        const html = await toolGetHtmlContent(url);
        return { url, html };
      }))
    );
    const validContents = htmlSettled
      .filter(s => s.status === 'fulfilled' && s.value && s.value.html)
      .map(s => s.value);

    // タイムボックス: 取得＋解析で時間超過している場合はここで早期終了
    // （validContentsが空ならそのまま返す）
    if (validContents.length === 0) return { candidates: [] };
    
    const prompt = `
# Role: List Page Analyst AI
# Task: From the provided HTML of event list pages, extract the full, absolute URLs of individual event detail pages.

# Input Pages:
${validContents.map(c => `## Base URL: ${c.url}\n## HTML (first 8000 chars):\n${c.html.substring(0, 8000)}`).join('\n\n')}

# Extraction Guidelines:
- Find anchor tags (\`<a>\`) that link to a specific event page.
- Exclude navigation links, advertisements, and links to other list pages.
- **CRITICAL**: If you find a relative path (e.g., "/events/123"), you MUST construct the full URL using its Base URL.

# Output Instruction: Respond ONLY with a JSON object containing a "candidates" key.
{
  "candidates": [ { "eventName": "...", "url": "..." } ]
}`;
    const result = await callGenerativeAi(prompt, true, "gemini-1.5-flash-latest");
    return result;
}

async function agentFinalSelector(candidates, userData) {
    const prompt = `
# 役割
あなたは、最終選考委員会のAIです。提供された有効なイベント候補のリストから、ユーザーにとって最も良い選択肢を、多様性を確保しつつ最大4つまで選んでください。

# ユーザープロフィール
${JSON.stringify(userData, null, 2)}

# 候補リスト
${JSON.stringify(candidates, null, 2)}

# 選考プロセス
1.  **重複排除**: URLが異なっていても、同じイベントに関する候補を特定し、グループ化してください。
2.  **多様性の確認**: 最終選考には、可能であれば様々な種類のイベントや場所が含まれるようにしてください。同じ種類のイベントばかり（例: 動物園ばかり）を提案するのは避けてください。
3.  **最終選考**: ユーザーにとって最もユニークで、興味深く、関連性の高いイベントを最大4つまで選んでください。
4.  **理由説明**: なぜその4つを選んだのか、選考理由を日本語で簡潔に説明してください。

# 出力形式 (JSONオブジェクトのみ)
{
  "final_candidates": [ (選ばれた候補オブジェクトの配列) ],
  "reasoning": "（選考理由）"
}`;
    return await callGenerativeAi(prompt, true, "gemini-1.5-pro-latest");
}

async function agentAlternativeCategorizer(alternatives, userData) {
    const prompt = `
# 役割
あなたは、クリエイティブなコンテンツキュレーターです。最終選考には残らなかったものの、魅力的な「次点」のイベント候補がリストとして与えられます。あなたの仕事は、それらを1〜3個の創造的で魅力的なカテゴリに分類し、それぞれにキャッチーなタイトルを付けることです。

# ユーザープロフィール
${JSON.stringify(userData, null, 2)}

# 次点イベントリスト
${JSON.stringify(alternatives, null, 2)}

# キュレーションプロセス
1.  **リストの分析**: これらの次点候補に共通するテーマは何ですか？（例: 教育的、アウトドア、アート＆クラフトなど）
2.  **カテゴリ作成**: イベントを論理的なカテゴリにグループ分けしてください。
3.  **キャッチーなタイトル作成**: 各カテゴリについて、好奇心を刺激するような魅力的な日本語のタイトルを付けてください。

# 出力形式 (JSONオブジェクトのみ)
{
  "categorized_alternatives": [
    {
      "category_title": "...",
      "events": [ ... ]
    }
  ]
}`;
    return await callGenerativeAi(prompt, true, "gemini-1.5-flash-latest");
}

async function agentVisualScout(candidate, imageCandidates) {
    const prompt = `
# 役割
あなたは、アートディレクター兼画像鑑定士です。提供された画像URLのリストから、イベントのメインビジュアルとして最もふさわしい画像を**1枚だけ**選んでください。

# イベント情報
${JSON.stringify(candidate, null, 2)}

# 画像候補 (イベントページから抽出)
${JSON.stringify(imageCandidates, null, 2)}

# 鑑定ガイドライン
1.  **最優先**: "og_image"は、ほぼ常に最良の選択肢です。
2.  **画像リストの分析**: 'main_visual'のような説明的なファイル名や、関連性の高い'alt'テキストを探し、小さなロゴやアイコンは無視してください。

# 出力形式 (JSONオブジェクトのみ)
{
  "selectedImageUrl": "..."
}`;
    console.log('[ImageDebug] agentVisualScout invoked with', {
        eventName: candidate && candidate.eventName,
        url: candidate && candidate.url,
        og: !!(imageCandidates && imageCandidates.og_image),
        listCount: imageCandidates && imageCandidates.image_list ? imageCandidates.image_list.length : 0
    });
    const r = await callGenerativeAi(prompt, true, "gemini-1.5-flash-latest");
    console.log('[ImageDebug] agentVisualScout raw response:', r);
    return r;
}

async function agentFinalPlanner(investigatedData, userData) {
    if (!investigatedData || investigatedData.length === 0) return [];
    const prompt = `
# 役割
あなたは、パーソナルなお出かけプランナーAIです。吟味されたイベントリストの各項目について、ユーザーに合わせた詳細で心躍るようなお出かけプランを作成してください。

# ユーザープロフィール
${JSON.stringify(userData, null, 2)}

# 吟味済みイベントリスト (Source of Truth)
${JSON.stringify(investigatedData, null, 2)}

# ガイドライン
- 各イベントに対して、1つのプランオブジェクトを作成してください。
- **【最重要】**: コアデータ（eventName, date, url, location, summary, imageUrl）は正確にコピーしてください。
- **クリエイティブ項目**: planName, strategicGuide (whySpecial, logistics, babyInfo, sampleItinerary, packingList), alternativePlan については、楽しく詳細なコンテンツを生成してください。

# 【JSON出力に関する厳格なルール】 (絶対に遵守すること)
- あなたの出力は、後続のプログラムで自動的にJSON.parse()されます。
- **もしJSONの文法が少しでも間違っていた場合、システム全体がエラーとなり、あなたの出力は無効とみなされます。**
- 生成するJSONは必ずRFC 8259標準に準拠してください。
- 全てのキーと文字列の値はダブルクォーテーション（"）で囲ってください。
- 文字列内にダブルクォーテーションを含める場合は、必ずバックスラッシュでエスケープしてください（例: "イベント\\"すごい\\"です"）。
- オブジェクトや配列の最後の要素の後には、カンマを付けないでください（trailing commaの禁止）。

# 出力形式 (JSONオブジェクトのみ)
{
  "plans": [ ... ]
}`;
    const result = await callGenerativeAi(prompt, true, "gemini-1.5-pro-latest");
    return result ? result.plans : [];
}

module.exports = {
    agentGeographer,
    agentBroadEventSearcher,
    agentInspector,
    agentListPageAnalyzer,
    agentFinalSelector,
    agentAlternativeCategorizer,
    agentVisualScout,
    agentFinalPlanner,
};
