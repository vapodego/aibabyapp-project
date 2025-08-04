/**
 * =================================================================
 * 週次プランニング・バッチ (weeklyPlanner.js) - v5.3 AI動作修正版
 * =================================================================
 * - agentGeographerが指示に従わず、自己紹介文を返してしまう問題を修正。
 * - プロンプトをより厳密にし、AIが余計な会話を生成しないように制御を強化しました。
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- APIキーの初期化 ---
const GEMINI_API_KEY = functions.config().gemini?.key;
const GOOGLE_API_KEY = functions.config().google?.key;
const GOOGLE_CX = functions.config().google?.cx;

let genAI;

if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
} else {
  console.error("Gemini APIキーが設定されていません。");
}
if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    console.error("Google APIのキーまたは検索エンジンIDが設定されていません。");
}

// =================================================================
// ヘルパー関数
// =================================================================

function parseJsonFromAiResponse(text, agentName) {
    if (!text) {
        console.error(`[${agentName}] AIからの応答が空です。`);
        return null;
    }
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    let jsonString = match ? match[1] : text;
    jsonString = jsonString.trim().replace(/,\s*([}\]])/g, '$1');

    try {
        return JSON.parse(jsonString);
    } catch (error) {
        console.error(`[${agentName}] JSONの解析に失敗しました。`, "解析対象:", jsonString, "エラー:", error);
        const firstBrace = jsonString.indexOf('{');
        const lastBrace = jsonString.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            try {
                const extractedJson = jsonString.substring(firstBrace, lastBrace + 1);
                return JSON.parse(extractedJson);
            } catch (innerError) {
                 console.error(`[${agentName}] JSONの再解析にも失敗しました。`, "エラー:", innerError);
                 return null;
            }
        }
        return null;
    }
}

async function callGenerativeAi(agentName, prompt, isJsonOutput = true) {
    if (!genAI) {
        console.error(`[${agentName}] Gemini AIが初期化されていません。`);
        return null;
    }
    
    const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash-latest",
        generationConfig: {
            temperature: 0.3,
            responseMimeType: isJsonOutput ? "application/json" : "text/plain",
        }
    });

    let attempt = 0;
    const maxRetries = 3;
    while (attempt < maxRetries) {
        try {
            const result = await model.generateContent(prompt);
            const responseText = result.response.text();
            if (!responseText) return null;

            return isJsonOutput ? parseJsonFromAiResponse(responseText, agentName) : responseText.trim();

        } catch (error) {
            attempt++;
            console.warn(`> [${agentName}]エージェントのエラー (試行 ${attempt}/${maxRetries}):`, error.message);
            if (attempt >= maxRetries) {
                console.error(`> [${agentName}]エージェントが最大リトライ回数に達しました。`);
                return null;
            }
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 2000));
        }
    }
}

// =================================================================
// メインコントローラー
// =================================================================
exports.runWeeklyPlansManually = functions
  .region("asia-northeast1")
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .https.onRequest(async (req, res) => {
    const db = admin.firestore();
    console.log("【v5.3 手動実行】週次お出かけプラン生成バッチを開始します。");

    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) {
        res.status(404).send("対象ユーザーが見つかりませんでした。");
        return;
    }

    const userDoc = usersSnapshot.docs[0];
    const userId = userDoc.id;
    const userData = userDoc.data();

    if (!userData.homeAddress || !userData.interests) {
        res.status(400).send(`ユーザーID: ${userId} はhomeAddressまたはinterestsが不足しているためスキップします。`);
        return;
    }

    try {
      console.log(`ユーザーID: ${userId} (${userData.homeAddress}) のプランを生成中...`);
      const { finalPlans, categorizedAlternatives } = await generatePlansForUser(userId, userData);
      
      if (finalPlans && finalPlans.length > 0) {
        await savePlansToFirestore(finalPlans, userId);
        console.log(`> ${finalPlans.length}件のプランをユーザーID: ${userId} のために保存しました。`);
        const html = generateHtmlResponse(finalPlans, categorizedAlternatives, userId, userData.homeAddress);
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

async function generatePlansForUser(userId, userData) {
    const searchArea = await agentGeographer(userData.homeAddress);
    console.log(`--- 行動範囲を「${searchArea}」に設定しました ---`);

    console.log("--- フェーズ1: 有望スポットの発見 ---");
    const promisingVenuesResult = await agentVenueScout(userData, searchArea);
    if (!promisingVenuesResult || !promisingVenuesResult.venues || promisingVenuesResult.venues.length === 0) {
        return { finalPlans: [], categorizedAlternatives: null };
    }
    const promisingVenues = promisingVenuesResult.venues;
    console.log(`> ${promisingVenues.length}件の有望な施設・サイトを発見しました。`);
    console.log("  > 選定理由:");
    promisingVenues.forEach(venue => console.log(`    - ${venue.name}: ${venue.reason}`));

    console.log("--- フェーズ2: 個別深掘り調査 ---");
    let allSearchResults = [];
    for (const venue of promisingVenues) {
        console.log(`  > 深掘り中: ${venue.name}`);
        const siteSpecificQuery = await agentSiteSpecificSearcher(venue, searchArea);
        if (siteSpecificQuery && siteSpecificQuery.query) {
            const searchResults = await toolGoogleSearch(siteSpecificQuery.query);
            allSearchResults.push(...searchResults);
        }
    }
    if (allSearchResults.length === 0) return { finalPlans: [], categorizedAlternatives: null };
    console.log(`> 合計${allSearchResults.length}件のイベント候補URLを取得しました。`);

    console.log("--- フェーズ3: 鑑定と深掘り ---");
    let validCandidates = [];
    let listPageUrls = [];
    const processedUrls = new Set();
    const uniqueUrls = [...new Set(allSearchResults.map(r => r.url))];

    for (const url of uniqueUrls) {
        if (processedUrls.has(url)) continue;
        processedUrls.add(url);
        const htmlContent = await toolGetHtmlContent(url);
        if (!htmlContent) continue;
        const inspectionResult = await agentInspector(url, htmlContent, userData);
        if (inspectionResult) {
            if (inspectionResult.isListPage) {
                listPageUrls.push(url);
            } else if (inspectionResult.isValid && inspectionResult.isMatch) {
                validCandidates.push({ ...inspectionResult, url: url });
            }
        }
    }

    if (listPageUrls.length > 0) {
        console.log(`--- フェーズ3.5: リストページの深掘り (${listPageUrls.length}件) ---`);
        const BATCH_SIZE = 5;
        for (let i = 0; i < listPageUrls.length; i += BATCH_SIZE) {
            const batchUrls = listPageUrls.slice(i, i + BATCH_SIZE);
            const extractedCandidates = await agentListPageAnalyzer(batchUrls);
            if (extractedCandidates && extractedCandidates.length > 0) {
                for (const candidate of extractedCandidates) {
                    const newUrl = candidate.url;
                    if (!newUrl || processedUrls.has(newUrl)) continue;
                    processedUrls.add(newUrl);
                    const htmlContent = await toolGetHtmlContent(newUrl);
                    if (!htmlContent) continue;
                    const inspectionResult = await agentInspector(newUrl, htmlContent, userData);
                    if (inspectionResult && inspectionResult.isValid && inspectionResult.isMatch) {
                         validCandidates.push({ ...inspectionResult, url: newUrl });
                    }
                }
            }
        }
    }

    if (validCandidates.length === 0) return { finalPlans: [], categorizedAlternatives: null };
    console.log(`> 鑑定を通過した候補が${validCandidates.length}件見つかりました。最終選考に移ります...`);
    
    const selectionResult = await agentFinalSelector(validCandidates, userData);
    if (!selectionResult || !selectionResult.final_candidates || selectionResult.final_candidates.length === 0) {
        return { finalPlans: [], categorizedAlternatives: null };
    }
    const finalCandidates = selectionResult.final_candidates;
    console.log(`> ★★★ ${finalCandidates.length}件の有効な候補を確保 ★★★`);
    console.log("  > 最終選考AIの判断理由:");
    console.log(`    ${selectionResult.reasoning.replace(/\n/g, '\n    ')}`);
    console.log("  > 最終候補リスト:");
    finalCandidates.forEach(candidate => console.log(`    - ${candidate.eventName} (${candidate.url})`));

    const finalCandidateUrls = new Set(finalCandidates.map(c => c.url));
    const alternativeCandidates = validCandidates.filter(c => !finalCandidateUrls.has(c.url));
    let categorizedAlternatives = null;
    if (alternativeCandidates.length > 0) {
        console.log(`--- フェーズ4.5: 代替案のカテゴリ分け (${alternativeCandidates.length}件) ---`);
        const result = await agentAlternativeCategorizer(alternativeCandidates, userData);
        if (result && result.categorized_alternatives) {
            categorizedAlternatives = result.categorized_alternatives;
            console.log("> 代替案のカテゴリ分けが完了しました。");
        }
    }

    console.log("--- フェーズ4: 画像抽出と最終プラン生成 ---");
    for (const candidate of finalCandidates) {
        const htmlContent = await toolGetHtmlContent(candidate.url);
        if(htmlContent){
            candidate.imageUrl = await findBestImageForEvent(candidate, htmlContent);
        }
    }

    const finalPlans = await agentFinalPlanner(finalCandidates, userData);
    
    return { finalPlans, categorizedAlternatives };
}

// =================================================================
// AIエージェント群
// =================================================================

// ▼▼▼【修正】Geographerのプロンプトを強化 ▼▼▼
async function agentGeographer(location) {
    const prompt = `
# INSTRUCTION
You are a geocoding expert. Your task is to expand a given location into a wider search area.

# TASK
Based on the user's location, suggest a wider area for event search within a 60-minute radius.

# RULES
- DO NOT include any introductory phrases, greetings, or conversational text.
- Your response MUST be ONLY the names of the areas as a simple string.
- DO NOT explain what you are doing.
- The output format must be a plain text string.

# USER LOCATION
"${location}"

# EXAMPLE OUTPUT
横浜・川崎・東京
`;
    return await callGenerativeAi("ジオグラファー", prompt, false) || location;
}
// ▲▲▲【ここまで】▲▲▲

async function agentVenueScout(userData, searchArea) {
    const prompt = `
# Role: Expert Local Scout
# Task: Based on the user's profile and the designated search area, list the top 5 most promising venues and 2 reliable portal sites to search for weekend events.
# User Profile:
${JSON.stringify(userData, null, 2)}
# Designated Search Area: "${searchArea}"
# Guidelines:
- Suggest specific, well-known facilities within the search area that match the user's interests.
- Also include major portal sites like 'iko-yo.net' or 'walkerplus.com'.
- For each suggestion, provide its name and a brief reason for your choice.
# Output Instruction: Respond ONLY with a JSON object.
{
  "venues": [
    { "name": "...", "reason": "..." },
    { "name": "いこーよネット", "reason": "子供向けイベントの網羅性が高いポータルサイト" }
  ]
}`;
    return await callGenerativeAi("有望スポット発見", prompt);
}

async function agentSiteSpecificSearcher(venue, searchArea) {
    const prompt = `
# Role: Deep-Dive Search Specialist
# Task: Create the most effective Google search query to find event information for a specific venue within a given area.
# Target Venue:
${JSON.stringify(venue, null, 2)}
# Search Area: "${searchArea}"
# Guidelines:
- The query MUST include the Search Area to ensure geographic relevance.
- If the venue name is a specific facility, combine it with the area.
- If the venue is a portal site (like 'iko-yo.net'), use the "site:" operator.
- Include Japanese keywords for events like "イベント", "お知らせ", "特別展".
- Add time-related keywords like "今週末".
# Output Instruction: Respond ONLY with a JSON object.
{ "query": "..." }`;
    return await callGenerativeAi("個別深掘り", prompt);
}

async function agentInspector(url, htmlContent, userData) {
    const prompt = `
# Role: Meticulous Appraiser AI
# Task: Analyze the provided HTML to classify the page, extract key information, AND assess if the event matches the user's interests.
# User Profile:
${JSON.stringify(userData, null, 2)}
# URL: ${url}
# HTML Content (first 15000 chars):
${htmlContent.substring(0, 15000)}
# Analysis Steps & Rules:
1.  **Classification**:
    - **Single Event**: The page is dedicated to ONE specific event.
    - **List Page**: The page contains a list of MULTIPLE distinct events. Key indicators are repetitive structures, "read more" links, and generic headings like "イベント一覧".
    - **Irrelevant**: Not an event page.
2.  **Extraction (if Single Event)**: Extract eventName, date, summary, location.
3.  **Appraisal (if Single Event)**: Is this a good match for the user's interests?
# Output Instruction: Respond ONLY with a single JSON object.
# - For a matching "Single Event":
#   {"isValid": true, "isMatch": true, "isListPage": false, "eventName": "...", "date": "...", "summary": "...", "location": {"name": "...", "address": "..."}}
# - For a non-matching "Single Event":
#   {"isValid": true, "isMatch": false, "reason": "Event type does not match user interests."}
# - For "List Page":
#   {"isValid": false, "isMatch": false, "isListPage": true}
# - For "Irrelevant":
#   {"isValid": false, "isMatch": false, "isListPage": false}`;
    return await callGenerativeAi(`鑑定士`, prompt);
}

async function agentListPageAnalyzer(urls) {
    const htmlContents = await Promise.all(urls.map(async (url) => {
        const html = await toolGetHtmlContent(url);
        return { url, html };
    }));
    const validContents = htmlContents.filter(c => c.html);
    if (validContents.length === 0) return [];
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
  "candidates": [
    { "eventName": "...", "url": "..." }
  ]
}`;
    const result = await callGenerativeAi("リストページ分析官", prompt);
    return result ? result.candidates : [];
}

async function agentFinalSelector(candidates, userData) {
    const prompt = `
# Role: Final Selection Committee AI
# Task: From the provided list of valid event candidates, select the top 4 best options for the user, ensuring diversity.
# User Profile:
${JSON.stringify(userData, null, 2)}
# Candidate List:
${JSON.stringify(candidates, null, 2)}
# Selection Process:
1.  **De-duplication**: Identify candidates that are about the same event, even if the URLs are different. Group them together.
2.  **Diversity Check**: Ensure the final selection includes a variety of event types and locations, if possible. Avoid suggesting only one type of event (e.g., all zoo events).
3.  **Final Selection**: Choose up to 4 of the most unique, interesting, and relevant events for the user.
4.  **Reasoning**: Briefly explain your selection logic in Japanese. Why did you choose these specific four?

# Output Instruction: Respond ONLY with a JSON object with two keys: "final_candidates" (an array of the chosen candidate objects) and "reasoning" (a string).
`;
    return await callGenerativeAi("最終選考AI", prompt);
}

async function agentAlternativeCategorizer(alternatives, userData) {
    const prompt = `
# Role: Creative Content Curator
# Task: You are given a list of "runner-up" event candidates that are good, but not the absolute best match. Your job is to group them into 1-3 creative, appealing categories and write a catchy title for each.
# User Profile:
${JSON.stringify(userData, null, 2)}
# Runner-up Event List:
${JSON.stringify(alternatives, null, 2)}
# Curation Process:
1.  **Analyze the list**: What are the common themes among these alternatives? (e.g., educational, outdoors, arts & crafts).
2.  **Create Categories**: Group the events into logical categories.
3.  **Write Catchy Titles**: For each category, write an engaging title in Japanese that sparks curiosity. Examples: 「たまにはアートに触れるのはどう？」「学びがいっぱい！知的好奇心を満たす週末」「いつもと違う、ちょっとマニアックな体験」
# Output Instruction: Respond ONLY with a JSON object.
{
  "categorized_alternatives": [
    {
      "category_title": "...",
      "events": [
        { "eventName": "...", "url": "..." }
      ]
    }
  ]
}`;
    return await callGenerativeAi("代替案カテゴリ分けAI", prompt);
}

async function agentVisualScout(candidate, imageCandidates) {
    const prompt = `
# Role: Art Director & Image Appraiser
# Task: From the provided list of image URLs, select the single best image that represents the event's main visual.
# Event Information:
${JSON.stringify(candidate, null, 2)}
# Image Candidates (extracted from the event page):
${JSON.stringify(imageCandidates, null, 2)}
# Appraisal Guidelines:
1.  **Top Priority**: The "og_image" is almost always the best choice.
2.  **Analyze Image List**: Look for descriptive file names ('main_visual'), relevant 'alt' text, and ignore small logos/icons.
# Output Instruction: Respond ONLY with a JSON object.
{ "selectedImageUrl": "..." }`;
    return await callGenerativeAi(`画像鑑定士`, prompt);
}

async function agentFinalPlanner(investigatedData, userData) {
    if (!investigatedData || investigatedData.length === 0) return [];
    const prompt = `
# Role: Personal Activity Planner AI
# Task: Create a detailed and exciting outing plan for each vetted event, tailored to the user.
# User Profile:
${JSON.stringify(userData, null, 2)}
# Vetted Event List (Source of Truth):
${JSON.stringify(investigatedData, null, 2)}
# Guidelines:
- For each event, create one plan object.
- **CRITICAL**: Copy core data (eventName, date, url, location, summary, imageUrl) accurately.
- **Creative Fields**: Generate fun and detailed content for planName, strategicGuide (whySpecial, logistics, babyInfo, sampleItinerary, packingList), and alternativePlan.
# Output Instruction: Respond ONLY with a JSON object containing a "plans" key.`;
    const result = await callGenerativeAi(`最終プランナー`, prompt);
    return result ? result.plans : [];
}

// =================================================================
// ツール群
// =================================================================

async function toolGoogleSearch(query, num = 10) {
    if (!GOOGLE_API_KEY || !GOOGLE_CX) { return []; }
    const fullQuery = `${query}`.trim();
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(fullQuery)}&gl=jp&hl=ja&num=${num}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.items) return data.items.map(item => ({ eventName: item.title, url: item.link }));
        return [];
    } catch (error) {
        console.error(`> Web検索ツールエラー (クエリ: ${query}):`, error);
        return [];
    }
}

async function toolGeocode(address) {
    if (!address) {
        console.log("> Geocoding中止: 住所がnullです。");
        return null;
    }
    if (!GOOGLE_API_KEY) return null;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}&language=ja`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.status === 'OK' && data.results[0]) return data.results[0].geometry.location;
        return null;
    } catch (error) {
        console.error(`> Geocodingツールエラー (住所: ${address}):`, error);
        return null;
    }
}

async function toolGetHtmlContent(url) {
     try {
        const response = await fetch(url, { timeout: 8000, redirect: 'follow' });
        if (!response.ok) return null;
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('text/html')) return null;
        return await response.text();
    } catch (error) {
        return null;
    }
}

async function findBestImageForEvent(candidate, htmlContent) {
    const imageCandidates = parseImagesFromHtml(candidate.url, htmlContent);
    if (imageCandidates.og_image || imageCandidates.image_list.length > 0) {
        const result = await agentVisualScout(candidate, imageCandidates);
        if (result && result.selectedImageUrl) {
            console.log(`  > [画像抽出◎] 直接抽出に成功: ${candidate.eventName}`);
            return result.selectedImageUrl;
        }
    }
    console.log(`  > [画像抽出△] 直接抽出に失敗。Google画像検索に切り替えます: ${candidate.eventName}`);
    const fallbackQuery = `${candidate.location.name} ${candidate.eventName}`;
    return await toolGoogleImageSearch(fallbackQuery);
}

function parseImagesFromHtml(baseUrl, html) {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    let og_image = null;
    const ogImageElement = document.querySelector('meta[property="og:image"]');
    if (ogImageElement) {
        const ogImageUrl = ogImageElement.getAttribute('content');
        if(ogImageUrl) {
            try {
                og_image = new URL(ogImageUrl, baseUrl).href;
            } catch(e){/* ignore invalid url */}
        }
    }
    const image_list = [];
    document.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src');
        const alt = img.getAttribute('alt');
        if (src && !src.startsWith('data:')) {
            try {
                const absoluteUrl = new URL(src, baseUrl).href;
                image_list.push({ src: absoluteUrl, alt });
            } catch (e) {/* ignore invalid url */}
        }
    });
    return { og_image, image_list };
}

async function toolGoogleImageSearch(query) {
    if (!GOOGLE_API_KEY || !GOOGLE_CX) { return null; }
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&gl=jp&hl=ja&searchType=image&num=1`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.items && data.items.length > 0) {
            return data.items[0].link;
        }
        return null;
    } catch (error) {
        console.error(`> 画像検索ツールエラー (クエリ: ${query}):`, error);
        return null;
    }
}

// =================================================================
// HTML生成 & Firestore保存
// =================================================================

function generateHtmlResponse(plans, categorizedAlternatives, userId, location) {
    const plansHtml = plans.map(plan => {
        const babyInfo = plan.babyInfo || {};
        const strategicGuide = plan.strategicGuide || {};
        const locationInfo = plan.location || {};
        const formatMultilineText = (data) => {
            if (Array.isArray(data)) return data.join('<br>');
            if (typeof data === 'string') return data.replace(/\n/g, '<br>');
            return '記載なし';
        };
        const sampleItineraryHtml = formatMultilineText(strategicGuide.sampleItinerary);
        const packingListHtml = formatMultilineText(strategicGuide.packingList);
        return `
        <div class="bg-white rounded-2xl shadow-lg overflow-hidden mb-8 transform hover:scale-105 transition-transform duration-300">
            <img src="${plan.imageUrl || 'https://placehold.co/600x400/e2e8f0/cbd5e0?text=No+Image'}" alt="${plan.eventName || 'イベント画像'}" class="w-full h-56 object-cover" onerror="this.onerror=null;this.src='https://placehold.co/600x400/e2e8f0/cbd5e0?text=Image+Error';">
            <div class="p-6">
                <div class="flex items-baseline mb-4"><span class="inline-block bg-teal-200 text-teal-800 text-xs px-2 rounded-full uppercase font-semibold tracking-wide">${plan.eventType || 'イベント'}</span></div>
                <div class="bg-gray-50 p-4 rounded-lg mb-4 border border-gray-200">
                    <h2 class="text-xl font-bold text-gray-900"><a href="${plan.url || '#'}" target="_blank" rel="noopener noreferrer" class="hover:text-teal-600 transition-colors">イベント名：${plan.eventName || '名称不明'}</a></h2>
                    <p class="text-md text-gray-700 mt-1">日程：${plan.date || '要確認'}</p>
                </div>
                <h3 class="text-2xl font-bold text-gray-800 mb-2">${plan.planName || 'おすすめプラン'}</h3>
                <p class="text-gray-600 mb-4">${plan.summary || 'AIがあなたのために作成したお出かけプランです。'}</p>
                <div class="border-t border-gray-200 pt-4"><h4 class="text-lg font-semibold text-gray-700 mb-2">💌 このプランがあなたに最適な理由</h4><p class="text-gray-600 mb-4">${strategicGuide.whySpecial || '記載なし'}</p></div>
                <div class="border-t border-gray-200 pt-4"><h4 class="text-lg font-semibold text-gray-700 mb-2">📍 基本情報</h4><ul class="list-none text-gray-600 space-y-1"><li><strong>場所:</strong> ${locationInfo.name || '場所不明'} (${locationInfo.address || '住所不明'})</li></ul></div>
                <div class="border-t border-gray-200 pt-4 mt-4"><h4 class="text-lg font-semibold text-gray-700 mb-2">✨ 完璧な家族遠征のための戦略ガイド</h4><div class="space-y-3 text-gray-600"><p><strong><span class="text-teal-600">アクセス:</span></strong> ${strategicGuide.logistics || '記載なし'}</p><p><strong><span class="text-teal-600">赤ちゃん安心情報:</span></strong> ${strategicGuide.babyInfo || '記載なし'}</p><div><strong><span class="text-teal-600">モデルプラン:</span></strong><br><div class="mt-2 pl-4 border-l-2 border-teal-200">${sampleItineraryHtml}</div></div><div><strong><span class="text-teal-600">持ち物リスト:</span></strong><br><div class="mt-2 pl-4 border-l-2 border-teal-200">${packingListHtml}</div></div></div></div>
                <div class="border-t border-gray-200 pt-4 mt-4"><h4 class="text-lg font-semibold text-gray-700 mb-2">👶 赤ちゃん向け設備</h4><div class="flex flex-wrap gap-2 text-sm"><span class="px-3 py-1 rounded-full ${babyInfo.hasNursingRoom ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'}">授乳室 ${babyInfo.hasNursingRoom ? 'あり' : 'なし'}</span><span class="px-3 py-1 rounded-full ${babyInfo.hasDiaperChangeStation ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'}">おむつ交換台 ${babyInfo.hasDiaperChangeStation ? 'あり' : 'なし'}</span><span class="px-3 py-1 rounded-full ${babyInfo.isStrollerFriendly ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'}">ベビーカーOK</span></div><p class="text-gray-600 mt-2 text-sm">${babyInfo.notes || ''}</p></div>
                <div class="border-t border-gray-200 pt-4 mt-4"><h4 class="text-lg font-semibold text-gray-700 mb-2">☔️ もしもの時の代替案</h4><p class="text-gray-600">${plan.alternativePlan || '記載なし'}</p></div>
                <div class="mt-6 text-right"><a href="${plan.url || '#'}" target="_blank" rel="noopener noreferrer" class="inline-block bg-teal-500 text-white font-bold py-2 px-4 rounded-lg hover:bg-teal-600 transition-colors">公式サイトで詳細を見る</a></div>
            </div>
        </div>
        `;
    }).join('');

    let alternativesHtml = '';
    if (categorizedAlternatives && categorizedAlternatives.length > 0) {
        alternativesHtml = `
        <div class="mt-16">
            <h2 class="text-3xl font-bold text-gray-800 text-center mb-8">その他のご提案</h2>
            <div class="space-y-8">
        `;

        categorizedAlternatives.forEach(category => {
            alternativesHtml += `
            <div class="bg-white rounded-2xl shadow-lg p-6">
                <h3 class="text-2xl font-bold text-gray-700 mb-4">${category.category_title}</h3>
                <ul class="list-disc list-inside space-y-2">
            `;
            category.events.forEach(event => {
                alternativesHtml += `
                    <li class="text-gray-600"><a href="${event.url}" target="_blank" rel="noopener noreferrer" class="text-teal-600 hover:underline">${event.eventName}</a></li>
                `;
            });
            alternativesHtml += `</ul></div>`;
        });

        alternativesHtml += `</div></div>`;
    }

    return `
    <!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>今週のおすすめお出かけプラン</title><script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet"><style>body { font-family: 'Inter', sans-serif; }</style></head><body class="bg-gray-100"><div class="container mx-auto p-4 md:p-8"><header class="text-center mb-10"><h1 class="text-4xl font-bold text-gray-800">今週のおすすめお出かけプラン</h1><p class="text-gray-500 mt-2">AIがあなたのために厳選しました (ユーザーID: ${userId}, 場所: ${location})</p></header><main>${plansHtml}</main>${alternativesHtml}</div></body></html>
    `;
}

async function savePlansToFirestore(plans, userId) {
  const db = admin.firestore();
  const collectionRef = db.collection("users").doc(userId).collection("suggestedPlans");
  const snapshot = await collectionRef.get();
  if (!snapshot.empty) {
    const deleteBatch = db.batch();
    snapshot.docs.forEach(doc => { deleteBatch.delete(doc.ref); });
    await deleteBatch.commit();
  }
  if (!plans || plans.length === 0) return;
  const addBatch = db.batch();
  plans.forEach((plan) => {
    const planRef = collectionRef.doc();
    addBatch.set(planRef, {
      ...plan,
      createdAt: FieldValue.serverTimestamp(),
      version: "5.2-with-alternatives"
    });
  });
  return addBatch.commit();
}
