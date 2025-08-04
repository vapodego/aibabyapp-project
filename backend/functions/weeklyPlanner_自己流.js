/**
 * =================================================================
 * 週次プランニング・バッチ (weeklyPlanner.js) - モジュール版
 * =================================================================
 * - Firebaseの初期化処理を削除し、index.jsから呼び出されるモジュールとして再構成しました。
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require('node-fetch');
const https = require('https');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// (このファイルから admin.initializeApp() は削除)

// APIキーの初期化
const GEMINI_API_KEY = functions.config().gemini?.key;
const GOOGLE_API_KEY = functions.config().google?.key;
const GOOGLE_CX = functions.config().google?.cx;

let genAI;
let model;

if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  model = genAI.getGenerativeModel({
    model: "gemini-1.5-pro-latest",
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.2,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  });
} else {
  console.error("Gemini APIキーが設定されていません。");
}
if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    console.error("Google Search APIのキーまたは検索エンジンIDが設定されていません。");
}

// ローカル環境でのSSL証明書エラーを無視するエージェント
const httpsAgent = new https.Agent({
  rejectUnauthorized: process.env.FUNCTIONS_EMULATOR !== 'true'
});


// JSONパーサー: 変更なし
function parseJsonFromAiResponse(text, agentName) {
    if (!text) { return null; }
    let processedText = text.trim();
    const match = processedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
        processedText = match[1];
    }
    
    let cleanText = processedText.replace(/\s\/\/.*/g, '');
    cleanText = cleanText.replace(/\/\*[\s\S]*?\*\//g, '');
    cleanText = cleanText.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
    cleanText = cleanText.replace(/,\s*([}\]])/g, "$1");

    const findCompleteJson = (str) => {
        let firstBrace = str.indexOf('{');
        let firstBracket = str.indexOf('[');
        let startIndex = -1;
        if (firstBrace === -1 && firstBracket === -1) return null;
        if (firstBrace === -1) startIndex = firstBracket;
        else if (firstBracket === -1) startIndex = firstBrace;
        else startIndex = Math.min(firstBrace, firstBracket);
        const startChar = str[startIndex];
        const endChar = (startChar === '{') ? '}' : ']';
        let depth = 1;
        let endIndex = -1;
        for (let i = startIndex + 1; i < str.length; i++) {
            if (str[i] === startChar) depth++;
            else if (str[i] === endChar) depth--;
            if (depth === 0) {
                endIndex = i;
                break;
            }
        }
        if (endIndex === -1) return null;
        return str.substring(startIndex, endIndex + 1);
    };

    const jsonString = findCompleteJson(cleanText);
    if (!jsonString) { return null; }
    try {
        return JSON.parse(jsonString);
    } catch (error) {
        console.error(`[${agentName}] JSONの解析に失敗しました。`, "解析対象:", jsonString, "エラー:", error);
        return null;
    }
}
// HTML生成関数: 安定性向上
function generateHtmlResponse(plans, userId, location) {
    const plansHtml = plans.map(plan => {
        const babyInfo = plan.babyInfo || {};
        const strategicGuide = plan.strategicGuide || {};
        const locationInfo = plan.location || {};

        // データが配列でも文字列でも対応できるようにヘルパー関数を定義
        const formatMultilineText = (data) => {
            if (Array.isArray(data)) {
                return data.join('<br>');
            }
            if (typeof data === 'string') {
                return data.replace(/\n/g, '<br>');
            }
            return '記載なし';
        };

        const sampleItineraryHtml = formatMultilineText(strategicGuide.sampleItinerary);
        const packingListHtml = formatMultilineText(strategicGuide.packingList);

        return `
        <div class="bg-white rounded-2xl shadow-lg overflow-hidden mb-8 transform hover:scale-105 transition-transform duration-300">
            <img src="${plan.imageUrl || 'https://placehold.co/600x400/e2e8f0/cbd5e0?text=No+Image'}" alt="${plan.eventName || 'イベント画像'}" class="w-full h-56 object-cover" onerror="this.onerror=null;this.src='https://placehold.co/600x400/e2e8f0/cbd5e0?text=Image+Error';">
            <div class="p-6">
                <div class="flex items-baseline mb-4">
                    <span class="inline-block bg-teal-200 text-teal-800 text-xs px-2 rounded-full uppercase font-semibold tracking-wide">${plan.eventType || 'イベント'}</span>
                </div>
                
                <div class="bg-gray-50 p-4 rounded-lg mb-4 border border-gray-200">
                    <h2 class="text-xl font-bold text-gray-900">
                        <a href="${plan.url || '#'}" target="_blank" rel="noopener noreferrer" class="hover:text-teal-600 transition-colors">
                            イベント名：${plan.eventName || '名称不明'}
                        </a>
                    </h2>
                    <p class="text-md text-gray-700 mt-1">日程：${plan.date || '要確認'}</p>
                </div>

                <h3 class="text-2xl font-bold text-gray-800 mb-2">${plan.planName || 'おすすめプラン'}</h3>
                <p class="text-gray-600 mb-4">${plan.summary || 'AIがあなたのために作成したお出かけプランです。'}</p>

                <div class="border-t border-gray-200 pt-4">
                    <h4 class="text-lg font-semibold text-gray-700 mb-2">💌 このプランがあなたに最適な理由</h4>
                    <p class="text-gray-600 mb-4">${strategicGuide.whySpecial || '記載なし'}</p>
                </div>

                <div class="border-t border-gray-200 pt-4">
                    <h4 class="text-lg font-semibold text-gray-700 mb-2">📍 基本情報</h4>
                    <ul class="list-none text-gray-600 space-y-1">
                        <li><strong>場所:</strong> ${locationInfo.name || '場所不明'} (${locationInfo.address || '住所不明'})</li>
                    </ul>
                </div>

                <div class="border-t border-gray-200 pt-4 mt-4">
                    <h4 class="text-lg font-semibold text-gray-700 mb-2">✨ 完璧な家族遠征のための戦略ガイド</h4>
                     <div class="space-y-3 text-gray-600">
                        <p><strong><span class="text-teal-600">アクセス:</span></strong> ${strategicGuide.logistics || '記載なし'}</p>
                        <p><strong><span class="text-teal-600">赤ちゃん安心情報:</span></strong> ${strategicGuide.babyInfo || '記載なし'}</p>
                        <div><strong><span class="text-teal-600">モデルプラン:</span></strong><br><div class="mt-2 pl-4 border-l-2 border-teal-200">${sampleItineraryHtml}</div></div>
                        <div><strong><span class="text-teal-600">持ち物リスト:</span></strong><br><div class="mt-2 pl-4 border-l-2 border-teal-200">${packingListHtml}</div></div>
                    </div>
                </div>
                
                <div class="border-t border-gray-200 pt-4 mt-4">
                    <h4 class="text-lg font-semibold text-gray-700 mb-2">👶 赤ちゃん向け設備</h4>
                    <div class="flex flex-wrap gap-2 text-sm">
                        <span class="px-3 py-1 rounded-full ${babyInfo.hasNursingRoom ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'}">授乳室 ${babyInfo.hasNursingRoom ? 'あり' : 'なし'}</span>
                        <span class="px-3 py-1 rounded-full ${babyInfo.hasDiaperChangeStation ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'}">おむつ交換台 ${babyInfo.hasDiaperChangeStation ? 'あり' : 'なし'}</span>
                        <span class="px-3 py-1 rounded-full ${babyInfo.isStrollerFriendly ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'}">ベビーカーOK</span>
                    </div>
                    <p class="text-gray-600 mt-2 text-sm">${babyInfo.notes || ''}</p>
                </div>

                <div class="border-t border-gray-200 pt-4 mt-4">
                    <h4 class="text-lg font-semibold text-gray-700 mb-2">☔️ もしもの時の代替案</h4>
                    <p class="text-gray-600">${plan.alternativePlan || '記載なし'}</p>
                </div>

                <div class="mt-6 text-right">
                    <a href="${plan.url || '#'}" target="_blank" rel="noopener noreferrer" class="inline-block bg-teal-500 text-white font-bold py-2 px-4 rounded-lg hover:bg-teal-600 transition-colors">
                        公式サイトで詳細を見る
                    </a>
                </div>
            </div>
        </div>
        `;
    }).join('');

    return `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>今週のおすすめお出かけプラン</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
            body { font-family: 'Inter', sans-serif; }
        </style>
    </head>
    <body class="bg-gray-100">
        <div class="container mx-auto p-4 md:p-8">
            <header class="text-center mb-10">
                <h1 class="text-4xl font-bold text-gray-800">今週のおすすめお出かけプラン</h1>
                <p class="text-gray-500 mt-2">AIがあなたのために厳選しました (ユーザーID: ${userId}, 場所: ${location})</p>
            </header>
            <main>
                ${plansHtml}
            </main>
        </div>
    </body>
    </html>
    `;
}

// =================================================================
// メインのトリガー関数をエクスポート
// =================================================================
exports.runWeeklyPlansManually = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .https.onRequest(async (req, res) => {
    const db = admin.firestore();
    console.log("【手動実行】週次お出かけプラン生成バッチを開始します。");

    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) {
        res.status(404).send("対象ユーザーが見つかりませんでした。");
        return;
    }

    const userDoc = usersSnapshot.docs[0];
    const userId = userDoc.id;
    const userData = userDoc.data();

    if (!userData.location || !userData.interests) {
        res.status(400).send(`ユーザーID: ${userId} は情報が不十分なためスキップします。`);
        return;
    }

    try {
      console.log(`ユーザーID: ${userId} (${userData.location}) のプランを生成中...`);
      const plans = await generatePlansForUser(userId, userData);
      
      if (plans && plans.length > 0) {
        await savePlansToFirestore(plans, userId);
        console.log(`> ${plans.length}件のプランをユーザーID: ${userId} のために保存しました。`);
        
        const html = generateHtmlResponse(plans, userId, userData.location);
        res.status(200).send(html);

      } else {
        const noPlanMsg = `> 有効なプランが見つかりませんでした。`;
        console.log(noPlanMsg);
        res.status(200).send(`<h1>プランが見つかりませんでした</h1><p>${noPlanMsg}</p>`);
      }
    } catch (error) {
      console.error(`ユーザーID: ${userId} の処理中にエラーが発生しました:`, error);
      res.status(500).send(`Error processing user ${userId}: ${error.message}`);
    }
  });

// =================================================================
// メインコントローラー
// =================================================================
async function generatePlansForUser(userId, userData) {
    if (!model || !GOOGLE_API_KEY || !GOOGLE_CX) {
        console.error("APIキーまたは検索エンジンIDが初期化されていません。");
        return [];
    }

    let interestsArray = userData.interests;
    if (!Array.isArray(interestsArray)) {
        console.warn(`[データ型修正] ユーザー(${userId})の興味・関心(interests)が配列ではありませんでした。現在の型: ${typeof interestsArray}`);
        if (typeof interestsArray === 'string' && interestsArray.length > 0) {
            interestsArray = interestsArray.split(/[,、\s]+/).filter(Boolean);
            console.log(`  > 文字列から配列に変換しました: [${interestsArray.join(', ')}]`);
        } else {
            interestsArray = ["子供向け", "ファミリー", "お出かけ"];
            console.log(`  > デフォルトの興味・関心を設定しました: [${interestsArray.join(', ')}]`);
        }
    }
    
    console.log(`--- 調査開始: ユーザー(${userData.location}) ---`);
    
    const expandedArea = await agentGeographer(userData.location);
    const trustedSites = await agentTrustedSiteFinder(expandedArea);
    
    const allFoundCandidates = new Map();

    const searchQueries = await agentSearchStrategist(interestsArray, expandedArea, trustedSites);
    if (!searchQueries || searchQueries.length === 0) {
        console.log(`  > 戦略家AIが有効な検索クエリを生成できませんでした。`);
        return [];
    }
    console.log(`  > 戦略家AIが ${searchQueries.length}件の検索クエリを提案: ${searchQueries.map(q => `"${q.query}"`).join(', ')}`);

    const searchPromises = searchQueries.map(q => toolGoogleSearch(q.query, 10, q.sort));
    const searchResultsArray = await Promise.all(searchPromises);
    const searchResults = searchResultsArray.flat();

    if (searchResults.length === 0) {
        console.log(`  > 全ての検索クエリで結果が見つかりませんでした。`);
        return [];
    }
    console.log(`  > Web検索で合計 ${searchResults.length}件の候補を発見。`);

    const { validCandidates, listPageUrls } = await processSearchResults(searchResults, allFoundCandidates);

    if (listPageUrls.length > 0) {
        console.log(`  > ★ リストページを${listPageUrls.length}件発見。深掘り調査を開始します...`);
        const extractedCandidates = await agentListPageAnalyzer(listPageUrls);
        if (extractedCandidates && extractedCandidates.length > 0) {
            console.log(`  >   > リストページから新たに ${extractedCandidates.length}件の候補を抽出。`);
            const { validCandidates: newValidFromList } = await processSearchResults(extractedCandidates, allFoundCandidates);
            validCandidates.push(...newValidFromList);
        }
    }

    if (validCandidates.length === 0) {
        console.log(`  > 最終的に有効な候補は見つかりませんでした。`);
        return [];
    }

    console.log(`  > ★★★ 合計 ${validCandidates.length}件の有効な候補を確保。 ★★★`);
    
    const visualScoutPromises = validCandidates.map(candidate => agentVisualScout(candidate));
    const finalCandidates = await Promise.all(visualScoutPromises);

    return agentFinalPlanner(finalCandidates, userData);
}


// ヘルパー関数
async function processSearchResults(results, allFoundCandidates) {
    const newCandidates = results.filter(c => c && c.url && !allFoundCandidates.has(c.url));
    newCandidates.forEach(c => allFoundCandidates.set(c.url, c));

    const inspectionPromises = newCandidates.map(c => agentInspector(c.url, c.eventName));
    const inspectionResults = await Promise.all(inspectionPromises);
    
    const validCandidates = [];
    const listPageUrls = [];

    for (const result of inspectionResults) {
        if (result && result.isValid) {
            validCandidates.push(result);
        } else if (result && result.isListPage) {
            listPageUrls.push(result.url);
        }
    }
    
    console.log(`  > 監査結果: ${newCandidates.length}件中、合格${validCandidates.length}件, リストページ${listPageUrls.length}件`);
    return { validCandidates, listPageUrls };
}

// =================================================================
// AIエージェント定義
// =================================================================
async function callGenerativeAI(agentName, prompt, isJsonOutput = true) {
    let attempt = 0;
    const maxRetries = 3;
    while (attempt < maxRetries) {
        try {
            const config = isJsonOutput 
                ? { responseMimeType: "application/json" }
                : { responseMimeType: "text/plain" };

            const generativeModel = genAI.getGenerativeModel({
                model: "gemini-1.5-pro-latest",
                generationConfig: { ...model.generationConfig, ...config },
                safetySettings: model.safetySettings,
            });

            const result = await generativeModel.generateContent(prompt);
            const responseText = result.response.text();

            if (isJsonOutput) {
                return parseJsonFromAiResponse(responseText, agentName);
            }
            return responseText.trim();
        } catch (error) {
            attempt++;
            console.warn(`> ${agentName}エージェントのエラー (試行 ${attempt}/${maxRetries}):`, error.message);
            if (attempt >= maxRetries) {
                console.error(`> ${agentName}エージェントが最大リトライ回数に達しました。`);
                return null;
            }
            const delay = Math.pow(2, attempt) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}


// --- 事前準備エージェント ---
async function agentGeographer(location) {
    const prompt = `# Role: Geographer\n# Task: Based on the user's location, suggest a wider area for event search within a 60-minute radius.\n# User Location: "${location}"\n# Output Instruction: Provide only the names of the areas as a simple string.\n# Example Output: "横浜・川崎・東京"`;
    return callGenerativeAI("ジオグラファー", prompt, false) || location;
}

async function agentTrustedSiteFinder(area) {
    const prompt = `# Role: Trusted Site Finder\n# Task: Propose three reliable domains for children's event information in the specified area.\n# Area: "${area}"\n# Output Instruction: Respond ONLY with a JSON object containing a "sites" key with an array of domain strings.`;
    const result = await callGenerativeAI("信頼サイト発見", prompt);
    return result ? result.sites : [];
}

// --- 検索実行エージェント (AIベース) ---
async function agentSearchStrategist(interests, area, sites) {
    const prompt = `
# Role: Search Strategist AI (Weekend Outing)
# Task: Generate 3-5 diverse Google search queries to find "special weekend events" for a family.
# User Profile:
- Interests: ${interests.join(', ')}
- Area (Wide): ${area}
- Trusted Sites: ${sites.join(', ')}
# Query Generation Guidelines:
1.  **Keywords**: Use a mix of generic keywords (イベント, お出かけ, 祭り) and user's specific interests.
2.  **Time**: Use keywords like "今週末", "土日", "祝日".
3.  **Trusted Sites**: Create at least one query that specifically targets the trusted sites using "site:".
# Output Instruction: Respond ONLY with a JSON object containing a "queries" key with a list of query objects.
# Example:
{ "queries": [
    { "query": "(${sites.map(s => `site:${s}`).join(' OR ')}) ${area} 子供 イベント 今週末", "sort": "date" },
    { "query": "${area} ${interests[0] || '公園'} 祭り", "sort": "relevance" }
]}`;
    
    const result = await callGenerativeAI("検索戦略家", prompt);
    return result ? result.queries : [];
}

// --- 分析エージェント (HTML直接分析) ---
async function agentInspector(url, eventNameHint) {
    const htmlContent = await toolGetHtmlContent(url);
    if (!htmlContent) {
        return { isValid: false, url, reason: "ページの取得に失敗しました。" };
    }

    const prompt = `# Role: Meticulous Inspector AI\n# Task: Analyze the provided HTML to classify the page and EXTRACT key information. Every field is mandatory.\n# URL: ${url}\n# Event Name Hint: ${eventNameHint}\n# HTML Content (first 12000 chars):\n${htmlContent.substring(0, 12000)}\n\n# Classification & Extraction Rules:\n- **Single Event**: The page is for one specific event.\n  - **Extraction**: You MUST extract all the following fields. If a field is not found, you MUST use a specific "not found" string (e.g., "情報なし" or "要確認"). DO NOT omit any fields.\n    - \`eventName\`: The official name of the event.\n    - \`date\`: The specific date(s) or period. (e.g., "2025年8月10日(日)", "8月1日～8月31日")\n    - \`summary\`: A brief, one-sentence description of the event.\n    - \`location\`: An object with the venue name and address.\n- **List Page**: The page lists multiple events.\n- **Irrelevant**: Not an event page.\n\n# Output Instruction: Respond ONLY with a single JSON object. ALL fields are mandatory as specified.\n# - For "Single Event":\n#   {"isValid": true, "isListPage": false, "url": "${url}", "eventName": "...", "date": "...", "summary": "...", "location": {"name": "...", "address": "..."}}\n# - For "List Page":\n#   {"isValid": false, "isListPage": true, "url": "${url}"}\n# - For "Irrelevant":\n#   {"isValid": false, "isListPage": false, "url": "${url}", "reason": "This is a news article."}`;
    return callGenerativeAI(`監査官`, prompt);
}

async function agentListPageAnalyzer(urls) {
    const htmlContents = await Promise.all(urls.map(url => toolGetHtmlContent(url).then(html => ({url, html}))));
    const validContents = htmlContents.filter(c => c.html);
    if (validContents.length === 0) return [];

    const prompt = `# Role: List Page Analyst AI\n# Task: Analyze the HTML of event list pages and extract individual event names and their detail page URLs.\n# Input Pages (URL and HTML content):\n${validContents.map(c => `## URL: ${c.url}\n## HTML (first 8000 chars):\n${c.html.substring(0, 8000)}`).join('\n\n')}\n# Extraction Guidelines:\n- Find anchor tags (\`<a>\`) that link to a specific event page.\n- The link text is usually the event name.\n- Exclude navigation links and advertisements.\n- Ensure the extracted URL is a full, absolute URL.\n# Output Instruction: Respond ONLY with a JSON object containing a "candidates" key with a flat array of all found events.`;
    const result = await callGenerativeAI("リストページ分析官", prompt);
    return result ? result.candidates : [];
}


// =================================================================
// ツール定義
// =================================================================
async function toolGoogleSearch(query, num = 10, sort = 'relevance') {
    if (!GOOGLE_API_KEY || !GOOGLE_CX) { return []; }
    
    const fullQuery = `${query} -求人 -採用 -募集 -不動産 -転職 -株価 -中古`.trim();
    const dateRestrict = 'w1';
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(fullQuery)}&gl=jp&hl=ja&num=${num}&dateRestrict=${dateRestrict}&sort=${sort}`;
    
    try {
        const response = await fetch(url, { agent: httpsAgent });
        const data = await response.json();
        if (data.items) {
            return data.items.map(item => ({ eventName: item.title, url: item.link }));
        }
        return [];
    } catch (error) {
        console.error(`> Web検索ツールエラー (クエリ: ${query}):`, error);
        return [];
    }
}

async function toolGetHtmlContent(url) {
    try {
        const response = await fetch(url, { timeout: 8000, redirect: 'follow', agent: httpsAgent });
        if (!response.ok) return null;
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('text/html')) {
            return null;
        }
        return await response.text();
    } catch (error) {
        console.error(`> HTML取得ツールエラー (URL: ${url}):`, error.message);
        return null;
    }
}


// =================================================================
// 最終処理AIエージェント
// =================================================================
async function agentVisualScout(candidate) {
    const prompt = `# Role: Visual Scout AI\n# Task: Find a single, compelling, and relevant image URL for the given event.\n# Event Information:\n${JSON.stringify(candidate, null, 2)}\n# Image Search Guidelines:\n- The image must be directly related to the event.\n- Prefer official images. Avoid logos or banners.\n- The output must be a direct image link (e.g., ending in .jpg, .png).\n# Output Instruction: Respond ONLY with a JSON object containing the "imageUrl" key. If not found, provide null.`;
    const result = await callGenerativeAI(`ビジュアル・スカウト`, prompt);
    if (result && result.imageUrl) {
        return { ...candidate, imageUrl: result.imageUrl };
    }
    return candidate;
}

async function agentFinalPlanner(investigatedData, userData) {
    if (!investigatedData || investigatedData.length === 0) {
        return [];
    }
    
    const prompt = `
# Role: Personal Activity Planner AI
# Task: Create a detailed, "Agent Mode-ready" outing plan for each vetted event.
# User Profile:
${JSON.stringify(userData, null, 2)}

# Vetted Event List (Source of Truth):
${JSON.stringify(investigatedData, null, 2)}

# Plan Creation Guidelines:
- For each event in the "Vetted Event List", create one corresponding plan object.
- **CRITICAL (Data Transfer)**: You MUST copy the following fields directly from each vetted event into your output plan object. This is your most important task.
    - \`eventName\`
    - \`date\`
    - \`url\`
    - \`location\`
    - \`summary\` (Use this as a base for the new summary)
    - \`imageUrl\`
- **Creative Fields (Agent-Mode Ready)**: After copying the core data, generate these detailed fields:
    - \`planName\`: Create a fun, catchy title for the outing.
    - \`summary\`: Enhance the original summary to be more exciting and personal for the user's family.
    - \`strategicGuide\`: This is a detailed guide for the day.
        - \`whySpecial\`: Explain why this specific event is a perfect match for the user's interests.
        - \`logistics\`: Suggest the best way to get there (car/train) and parking/station info.
        - \`babyInfo\`: Detail baby-friendly aspects (stroller access, etc.), drawing from the event data.
        - \`sampleItinerary\`: Propose a detailed timeline for the day (e.g., "10:00: 出発", "10:30: 現地到着・散策", "12:30: XXXXでランチ", "15:00: 現地出発"). Include lunch/cafe suggestions. This can be a string or an array of strings.
        - \`packingList\`: Suggest a checklist of items to bring (e.g., "おむつ、おしりふき、着替え、飲み物、おやつ、日焼け止め"). This can be a string or an array of strings.
- **Other Fields**:
    - \`babyInfo\`: Fill in the boolean flags based on the event data or reasonable assumptions.
    - \`alternativePlan\`: Suggest a simple backup plan nearby in case of bad weather or cancellation.

# Output Instruction: Respond ONLY with a JSON object containing a "plans" key. The array inside "plans" MUST contain one object for each event from the input list, with all fields correctly populated.`;
    const result = await callGenerativeAI(`最終プランナー`, prompt);
    return result ? result.plans : [];
}

// =================================================================
// Firestore関連ヘルパー
// =================================================================
async function savePlansToFirestore(plans, userId) {
  const db = admin.firestore();
  const collectionRef = db.collection("users").doc(userId).collection("suggestedPlans");
  
  const snapshot = await collectionRef.get();
  if (!snapshot.empty) {
    const deleteBatch = db.batch();
    snapshot.docs.forEach(doc => { deleteBatch.delete(doc.ref); });
    await deleteBatch.commit();
  }

  if (!plans || plans.length === 0) {
      console.log('DEBUG: No plans to save.');
      return;
  }

  const addBatch = db.batch();
  plans.forEach((plan) => {
    const planRef = collectionRef.doc();
    addBatch.set(planRef, {
      ...plan,
      createdAt: FieldValue.serverTimestamp(),
      version: "38.0" // バージョンを更新
    });
  });
  return addBatch.commit();
}
