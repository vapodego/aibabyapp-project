// このファイルは、v1とv2の両方から利用される共通関数を格納します。

const { JSDOM } = require('jsdom');
const fetch = require('node-fetch');
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- APIキーとAIクライアントの初期化 ---
const GEMINI_API_KEY = functions.config().gemini?.key;
const GOOGLE_API_KEY = functions.config().google?.key;
const GOOGLE_CX = functions.config().google?.cx;
let genAI;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

// =================================================================
// ツール群 と ヘルパー関数 (weeklyPlanner.jsから移動)
// =================================================================
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
    try {
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        if (!responseText) return null;
        const match = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        const jsonString = match ? match[1] : responseText;
        return isJsonOutput ? JSON.parse(jsonString.trim()) : responseText.trim();
    } catch (error) {
        console.error(`> [${agentName}]エージェントのエラー:`, error.message);
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
    return { og_image, image_list: [] }; // 簡略化
}

async function toolGoogleImageSearch(query) {
    if (!GOOGLE_API_KEY || !GOOGLE_CX) { return null; }
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&gl=jp&hl=ja&searchType=image&num=1`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        return data.items?.[0]?.link || null;
    } catch (error) {
        return null;
    }
}

// =================================================================
// AIエージェント群 (weeklyPlanner.jsから移動)
// =================================================================
async function agentGeographer(location) {
    const prompt = `# INSTRUCTION\nあなたは日本の地理に精通した専門家です。ユーザーの位置情報をもとに、Google検索クエリ用の広域イベント検索エリアを定義してください。\n# TASK\n 1.コア都道府県を特定する。2.複数の主要都市および隣接地域を含む広域検索エリアを定義する.\n# USER LOCATION\n"${location}"`;
    return await callGenerativeAi("ジオグラファー", prompt, false) || location;
}

async function findBestImageForEvent(candidate, htmlContent) {
    const imageCandidates = parseImagesFromHtml(candidate.url, htmlContent);
    if (imageCandidates.og_image) {
        return imageCandidates.og_image;
    }
    const fallbackQuery = `${candidate.location.name} ${candidate.eventName}`;
    return await toolGoogleImageSearch(fallbackQuery);
}

async function agentFinalPlanner(investigatedData, userData) {
    if (!investigatedData || investigatedData.length === 0) return [];
    const prompt = `# Role: Personal Activity Planner AI\n# Task: Create a detailed and exciting outing plan for each vetted event, tailored to the user.\n# User Profile:\n${JSON.stringify(userData, null, 2)}\n# Vetted Event List (Source of Truth):\n${JSON.stringify(investigatedData, null, 2)}\n# Guidelines:\n- For each event, create one plan object.\n- **CRITICAL**: Copy core data (eventName, date, url, location, summary, imageUrl) accurately.\n- **Creative Fields**: Generate fun and detailed content for planName, strategicGuide (whySpecial, logistics, babyInfo, sampleItinerary, packingList), and alternativePlan.\n# Output Instruction: Respond ONLY with a JSON object containing a "plans" key.`;
    const result = await callGenerativeAi(`最終プランナー`, prompt);
    return result ? result.plans : [];
}

async function agentAlternativeCategorizer(alternatives, userData) {
    const prompt = `# Role: Creative Content Curator\n# Task: Group "runner-up" event candidates into 1-3 creative, appealing categories and write a catchy title for each.\n# User Profile:\n${JSON.stringify(userData, null, 2)}\n# Runner-up Event List:\n${JSON.stringify(alternatives, null, 2)}\n# Output Instruction: Respond ONLY with a JSON object.\n{ "categorized_alternatives": [ { "category_title": "...", "events": [ { "eventName": "...", "url": "..." } ] } ] }`;
    return await callGenerativeAi("代替案カテゴリ分けAI", prompt);
}

async function savePlansToFirestore(plans, userId) {
  const db = admin.firestore();
  const userRef = db.collection("users").doc(userId);
  const collectionRef = userRef.collection("suggestedPlans");
  const snapshot = await collectionRef.get();
  if (!snapshot.empty) {
    const deleteBatch = db.batch();
    snapshot.docs.forEach(doc => { deleteBatch.delete(doc.ref); });
    await deleteBatch.commit();
  }
  if (!plans || plans.length === 0) {
    await userRef.set({ planGenerationStatus: 'completed' }, { merge: true });
    return;
  }
  const addBatch = db.batch();
  plans.forEach((plan) => {
    const planRef = collectionRef.doc();
    addBatch.set(planRef, { ...plan, createdAt: FieldValue.serverTimestamp(), version: "chatgpt-5" });
  });
  addBatch.set(userRef, { planGenerationStatus: 'completed' }, { merge: true });
  return addBatch.commit();
}

function generateHtmlResponse(plans, categorizedAlternatives, userId, location) {
    const plansHtml = plans.map(plan => `
        <div style="border:1px solid #ccc; padding:10px; margin-bottom:10px;">
            <h2><a href="${plan.url}">${plan.planName} (${plan.eventName})</a></h2>
            <img src="${plan.imageUrl || ''}" width="300" />
            <p><strong>日程:</strong> ${plan.date}</p>
            <p>${plan.summary}</p>
        </div>
    `).join('');
    return `<html><body><h1>プラン提案 for ${userId}</h1>${plansHtml}</body></html>`;
}


// v1とv2の両方から使えるように、必要な関数をエクスポート
module.exports = {
    findBestImageForEvent,
    agentFinalPlanner,
    savePlansToFirestore,
    generateHtmlResponse,
    toolGetHtmlContent,
    agentAlternativeCategorizer,
    agentGeographer,
};