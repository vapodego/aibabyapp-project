import React, { useMemo, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { getApp } from 'firebase/app';
import { getFirestore, doc, getDoc, collection, query, orderBy, getDocs } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import NestedQA from '../components/NestedQA';
import { splitToSentences } from '../components/NestedQA';
import ParagraphWithQA from '../components/ParagraphWithQA';
import { normalizeKey, parseAnswerLine } from '../utils/keying';

// ---- Stable sentence hashing (anchor) ----
function normalizeForHash(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ') // collapse spaces
    .replace(/[、。・:：;；!！?？…「」『』（）()【】\[\]`*_>#\-]/g, '')
    .trim();
}
function hashDjb2(str) {
  let h = 5381; let i = str.length;
  while (i) { h = (h * 33) ^ str.charCodeAt(--i); }
  return (h >>> 0).toString(36);
}
function stableIdFor(s) { return hashDjb2(normalizeForHash(s)); }


/**
 * MonthlyArticleScreen
 * - 月齢（month:number）を受け取り、記事を表示
 * - 本文を「文」単位でタップ可能にし、選んだ文を文脈として下部の質問バーに差し込む
 * - 質問を送信すると Chat 画面へ遷移（route: 'Chat'）し、initialText にコンテキスト付き質問を渡す
 */
// Paragraph templates used in this screen (keep in sync with JSX)
function buildParagraphs(displayMonth) {
  const p1 = `今月は${displayMonth}か月の節目。首や体幹の安定、声や表情のやり取りが一段と豊かになります。個人差は大きいので「できる/できない」で焦らなくて大丈夫です。`;
  const p2 = `睡眠や授乳のリズムは少しずつ整っていきますが、夜の覚醒が続くこともあります。環境の明暗や生活音の整え方、抱っこの姿勢、ミルク/母乳の回数など、あなたの家庭で無理なく続けられる工夫を探していきましょう。`;
  const p3 = `目を合わせてゆっくり話しかける、歌を添える、短時間の外気浴を取り入れるなど、簡単で続けやすい関わりが効果的です。季節に応じた保湿や暑さ寒さへの配慮も忘れずに。`;
  const p4 = `ここまで来たのは立派な成果です。できていない所ではなく、できている所に目を向けてください。頼れる所に頼ることは、家族の健康を守る選択です。`;
  return [p1, p2, p3, p4];
}

export default function MonthlyArticleScreen() {
  const route = useRoute();
  const navigation = useNavigation();
  const month = Number(route?.params?.month ?? 3); // デフォルト: 3ヶ月

  const [selectedSentence, setSelectedSentence] = useState(null);
  const [selectedBaseSentence, setSelectedBaseSentence] = useState(null); // 深掘りの基準になる本文の文
  const selectedSentenceRef = useRef(null);
  const setSelectedSentenceBoth = (s) => { setSelectedSentence(s); selectedSentenceRef.current = s; };
  const [question, setQuestion] = useState('');
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const [isAsking, setIsAsking] = useState(false);
  const [answersBySentence, setAnswersBySentence] = useState({}); // { [sentence:string]: Array<QA> }
  const [expandedSentences, setExpandedSentences] = useState({}); // { [sentence:string]: boolean }
  const [sentencePositions, setSentencePositions] = useState({}); // { [sentence:string]: number(y) }
  const [childAnswersBySentence, setChildAnswersBySentence] = useState({}); // { [answerSentence:string]: Array<QA> }
  const [expandedNestedSentences, setExpandedNestedSentences] = useState({}); // { [answerSentence:string]: boolean }
  const [grandAnswersBySentence, setGrandAnswersBySentence] = useState({}); // { [answerSentenceLv2:string]: Array<QA> }
  const [expandedGrandNested, setExpandedGrandNested] = useState({}); // { [answerSentenceLv2:string]: boolean }

  // --- In-app lightweight debug overlay (for test builds without console output) ---
  const [debugLog, setDebugLog] = useState(null);
  const pushDebug = (obj) => {
    try {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
      setDebugLog(`[MonthlyArticle] ${s}`);
      setTimeout(() => setDebugLog(null), 8000);
    } catch (_) {}
  };

  const MAX_DEPTH = 3; // 深掘りは最大3段

  const getCurrentDepthForSentence = (s) => {
    const list = answersBySentence[s] || [];
    if (list.length === 0) return 0;
    return list.reduce((m, q) => Math.max(m, q.depth || 0), 0);
  };

  const articleId = route?.params?.articleId || null;
  const [article, setArticle] = useState(null);
  const [loadingArticle, setLoadingArticle] = useState(!!articleId);
  const db = useMemo(() => getFirestore(getApp()), []);
  const fns = useMemo(() => getFunctions(getApp(), 'asia-northeast1'), []);

  const auth = useMemo(() => getAuth(getApp()), []);

  // Load user's saved Q&A for this article and place them back onto sentences
  React.useEffect(() => {
    let isActive = true;
    const run = async () => {
      try {
        if (!articleId) return;
        const uid = auth.currentUser?.uid;
        if (!uid) return; // not signed in; skip
        const colRef = collection(db, `users/${uid}/articles/${articleId}/qa`);
        const q = query(colRef, orderBy('createdAt', 'asc'));
        const snap = await getDocs(q);
        if (!isActive) return;
        const bySentence = {};
        const byChild = {};
        const byGrand = {};
        snap.forEach(docSnap => {
          const d = docSnap.data();
          const qa = {
            id: docSnap.id,
            question: d.question || '',
            answer: String(d?.answer?.text || d?.answer || ''),
            createdAt: d.createdAt || null,
            depth: d.depth || 1,
          };

          if (qa.depth === 1) {
            const a = d?.anchor || {};
            const h = a?.sentenceHash || null;
            let baseText = null;
            if (h && sentenceMaps.hashToText.has(h)) {
              baseText = sentenceMaps.hashToText.get(h).text;
            } else if (d?.selection?.quote && sentenceMaps.textToHash.has(d.selection.quote)) {
              baseText = d.selection.quote;
            }
            if (!baseText) return; // anchorできない一次回答はスキップ
            qa.selectedSentence = baseText;
            bySentence[baseText] = [qa, ...(bySentence[baseText] || [])];
          } else if (qa.depth === 2) {
            const key2 = (d?.selection?.quote && normalizeKey(String(d.selection.quote))) || null;
            if (!key2) return; // 深掘り対象の回答文が無ければスキップ
            qa.selectedSentence = key2;
            byChild[key2] = [qa, ...(byChild[key2] || [])];
          } else {
            const key3 = (d?.selection?.quote && normalizeKey(String(d.selection.quote))) || null;
            if (!key3) return;
            qa.selectedSentence = key3;
            byGrand[key3] = [qa, ...(byGrand[key3] || [])];
          }
        });
        setAnswersBySentence(prev => ({ ...prev, ...bySentence }));
        setChildAnswersBySentence(prev => ({ ...prev, ...byChild }));
        setGrandAnswersBySentence(prev => ({ ...prev, ...byGrand }));
        // auto-expand sentences that have QA
        const exp = {};
        Object.keys(bySentence).forEach(k => { exp[k] = true; });
        setExpandedSentences(prev => ({ ...prev, ...exp }));
      } catch (e) {
        console.warn('[MonthlyArticle] load QAs failed:', e);
      }
    };
    run();
    return () => { isActive = false; };
  }, [articleId, db, auth, sentenceMaps]);

  React.useEffect(() => {
    let isActive = true;
    const run = async () => {
      if (!articleId) return; // no-op
      try {
        setLoadingArticle(true);
        const ref = doc(db, 'articles', articleId);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          console.warn('[MonthlyArticle] article not found:', articleId);
          return;
        }
        if (isActive) setArticle({ id: snap.id, ...snap.data() });
      } catch (e) {
        console.warn('[MonthlyArticle] failed to load article:', e);
      } finally {
        if (isActive) setLoadingArticle(false);
      }
    };
    run();
    return () => { isActive = false; };
  }, [articleId, db]);

  // 表示用の月齢は記事由来を優先（なければ route の month）
  const displayMonth = useMemo(() => {
    const m = Number(article?.monthAge ?? month);
    return Number.isFinite(m) ? m : month;
  }, [article, month]);

  // Paragraphs & sentence hash maps
  const paragraphs = useMemo(() => buildParagraphs(displayMonth), [displayMonth]);
  const sentenceMaps = useMemo(() => {
    const textToHash = new Map();
    const hashToText = new Map();
    paragraphs.forEach((p, pi) => {
      const ss = splitToSentences(p);
      ss.forEach((s, si) => {
        const h = stableIdFor(s);
        textToHash.set(s, { hash: h, pi, si });
        if (!hashToText.has(h)) hashToText.set(h, { text: s, pi, si });
      });
    });
    return { textToHash, hashToText };
  }, [paragraphs]);

  // タイトル（記事に title があればそれを使用。無ければ祝うトーンのデフォルト）
  const title = useMemo(() => {
    if (article?.title) return article.title;
    return `祝・${displayMonth}か月！今月の成長ポイントと親のヒント`;
  }, [article, displayMonth]);

  // 本文（記事に body があれば使用。無ければテンプレート）
  const body = useMemo(() => {
    if (article?.body) return String(article.body);
    return buildMonthlyBody(displayMonth);
  }, [article, displayMonth]);

  // 文単位に分解（日本語句点・感嘆・疑問・改行）
  const sentences = useMemo(() => splitToSentences(body), [body]);


  if (loadingArticle) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
        <Text style={{ marginTop: 8 }}>記事を読み込んでいます…</Text>
      </View>
    );
  }

  const handleSentencePress = (s) => {
    setSelectedSentenceBoth(s);
    setSelectedBaseSentence(s);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleAnswerSentenceDeepDive = (s, baseDepth) => {
    // ベース未設定なら先に本文の文をタップしてもらう
    if (!selectedBaseSentence) {
      Alert.alert('文の選択', 'まず本文の気になる一文をタップしてから、回答内で深掘りしてください。');
      return;
    }
    const baseKey = selectedBaseSentence;
    const cur = typeof baseDepth === 'number' ? baseDepth : getCurrentDepthForSentence(baseKey);
    if (cur >= MAX_DEPTH) {
      Alert.alert('深掘りの上限', `この文での深掘りは最大${MAX_DEPTH}段までです。`);
      return;
    }
    setSelectedSentenceBoth(s);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSend = async () => {
    const trimmed = question.trim();
    const currentSelected = selectedSentenceRef.current;
    console.log('[MonthlyArticle] handleSend start', { selectedSentence: currentSelected, trimmed });
    if (!trimmed) return;

    try {
      // 深掘り上限チェック（本文の文＝ベースに対して）
      const baseKey = selectedBaseSentence || currentSelected || null;
      if (!baseKey) {
        Alert.alert('文を選択', 'まず本文の気になる一文をタップしてから送信してください。');
        return;
      }
      console.log('[MonthlyArticle] baseKey accepted', { baseKey });
      const curDepth = getCurrentDepthForSentence(baseKey);
      if (curDepth >= MAX_DEPTH) {
        Alert.alert('深掘りの上限', `この文での深掘りは最大${MAX_DEPTH}段までです。`);
        return;
      }

      setIsAsking(true);
      console.log('[MonthlyArticle] calling askArticleQuestion...', { articleId, displayMonth });
      const ask = httpsCallable(fns, 'askArticleQuestion');
      const depthToSend = Math.min(curDepth + 1, MAX_DEPTH);
      const baseQaId = Array.isArray(answersBySentence[baseKey]) && answersBySentence[baseKey][0]
        ? (answersBySentence[baseKey][0].id || null)
        : null;
      const parentId = depthToSend > 1 ? baseQaId : null;

      // Only attach anchor for depth=1
      const sentenceMeta = sentenceMaps.textToHash.get(baseKey) || { hash: stableIdFor(baseKey) };
      const anchorForSend = depthToSend === 1 ? {
        sentenceHash: sentenceMeta.hash,
        paragraphIndex: sentenceMeta.pi ?? null,
        sentenceIndex: sentenceMeta.si ?? null,
        articleVersion: Number(article?.version ?? 1),
      } : null;

      // ✅ Unify selection "display" and key with the same parser/normalizer used in UI
      const selectionDisplay = depthToSend === 1 ? baseKey : parseAnswerLine(currentSelected).display;
      const selectionKey = depthToSend === 1 ? baseKey : normalizeKey(selectionDisplay);

      console.log('[MonthlyArticle] calling askArticleQuestion payload', {
        articleId: articleId || null,
        question: trimmed,
        depth: depthToSend,
        parentId,
        anchor: anchorForSend,
        selection: { quote: selectionDisplay },
        selectionKey,
      });

      const result = await ask({
        articleId: articleId || null,
        question: trimmed,
        depth: depthToSend,
        parentId,
        anchor: anchorForSend,
        selection: { quote: selectionDisplay },
      });
      console.log('[MonthlyArticle] askArticleQuestion result', result?.data);
      const server = result?.data || {};
      const baseKey2 = baseKey;
      const qa = {
        id: server.id || Date.now().toString(),
        question: trimmed,
        answer: String(server?.answer?.text || server?.answer || '（応答を取得できませんでした）'),
        // 保存・即時反映ともに UI と同じ display 文面を持たせる（キーは参照側で normalize）
        selectedSentence: selectionDisplay,
        createdAt: new Date().toISOString(),
        depth: Math.min(curDepth + 1, MAX_DEPTH),
      };
      if (currentSelected === baseKey2) {
        // ベース文への一次回答
        setAnswersBySentence((prev) => {
          const updated = {
            ...prev,
            [baseKey2]: [qa, ...(prev[baseKey2] || [])],
          };
          console.log('[MonthlyArticle] appended QA (base)', { baseKey: baseKey2, depth: qa.depth, count: updated[baseKey2].length });
          return updated;
        });
        // 自動で「ひらく」
        setExpandedSentences((prev) => ({ ...prev, [baseKey2]: true }));
      } else {
        // 回答文への二次/三次回答：選択した回答文の直下にネスト表示
        console.log('[MonthlyArticle] child-append key', { keyFromQA: qa.selectedSentence, norm: normalizeKey(qa.selectedSentence), keyFromRef: currentSelected, keyFromState: selectedSentence });
        pushDebug({ tag: 'child-append-key', keyFromQA: qa.selectedSentence, norm: normalizeKey(qa.selectedSentence), keyFromRef: currentSelected, keyFromState: selectedSentence });
        const key = normalizeKey(qa.selectedSentence); // 保存・復元と同じ正規化テキストを使用
        if ((qa.depth || 0) <= 2) {
          // 2段目（child）
          setChildAnswersBySentence((prev) => {
            const updated = { ...prev, [key]: [qa, ...(prev[key] || [])] };
            {
              const payload = { key, depth: qa.depth, count: updated[key].length };
              console.log('[MonthlyArticle] appended QA (child)', payload);
              pushDebug({ tag: 'child-append', ...payload });
            }
            return updated;
          });
          setExpandedNestedSentences((prev) => ({ ...prev, [key]: true }));
        } else {
          // 3段目（grand）
          setGrandAnswersBySentence((prev) => {
            const updated = { ...prev, [key]: [qa, ...(prev[key] || [])] };
            {
              const payload = { key, depth: qa.depth, count: updated[key].length };
              console.log('[MonthlyArticle] appended QA (grand)', payload);
              pushDebug({ tag: 'grand-append', ...payload });
            }
            return updated;
          });
          setExpandedGrandNested((prev) => ({ ...prev, [key]: true }));
        }
        // 親（ベース）も開いておく
        setExpandedSentences((prev) => ({ ...prev, [baseKey2]: true }));
      }
      setTimeout(() => {
        const y = sentencePositions[baseKey2];
        console.log('[MonthlyArticle] scrollTo', { baseKey: baseKey2, y });
        if (typeof y === 'number') {
          try { scrollRef.current?.scrollTo({ y: Math.max(0, y - 120), animated: true }); } catch {}
        }
      }, 0);
      setQuestion('');
    } catch (e) {
      console.warn('[MonthlyArticle] askArticleQuestion catch', e);
      Alert.alert('エラー', e.message || '問い合わせに失敗しました');
    } finally {
      setIsAsking(false);
      console.log('[MonthlyArticle] handleSend finally');
    }
  };


  const toggleSentenceExpand = (s) => {
    setExpandedSentences((prev) => ({ ...prev, [s]: !prev[s] }));
  };
  const toggleNestedExpand = (ansSentence) => {
    const k = normalizeKey(ansSentence);
    setExpandedNestedSentences((prev) => ({ ...prev, [k]: !prev[k] }));
  };
  const toggleGrandNestedExpand = (ansSentence) => {
    const k = normalizeKey(ansSentence);
    setExpandedGrandNested((prev) => ({ ...prev, [k]: !prev[k] }));
  };

  // 文ごとのY座標を記録
  const registerSentenceLayout = (s, y) => {
    if (!s || typeof y !== 'number') return;
    setSentencePositions((prev) => (prev[s] === y ? prev : { ...prev, [s]: y }));
  };


  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.select({ ios: 72, android: 0 })}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{title}</Text>
        <Text style={styles.headerSubtitle}>生後{displayMonth}か月になりました。今月の見どころと、気になる点をその場で質問できます。</Text>
      </View>

      <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
        <Section title="発達の目安">
          <ParagraphWithQA
            text={paragraphs[0]}
            onPressSentence={handleSentencePress}
            selectedSentence={selectedSentence}
            answersBySentence={answersBySentence}
            expandedSentences={expandedSentences}
            onToggleExpand={toggleSentenceExpand}
            onPressAnswerSentence={handleAnswerSentenceDeepDive}
            onLayoutSentence={registerSentenceLayout}
            childAnswersBySentence={childAnswersBySentence}
            expandedNestedSentences={expandedNestedSentences}
            onToggleNestedExpand={toggleNestedExpand}
            grandAnswersBySentence={grandAnswersBySentence}
            expandedGrandNested={expandedGrandNested}
            onToggleGrandNestedExpand={toggleGrandNestedExpand}
            onDebug={pushDebug}
            debugChildKeys={Object.keys(childAnswersBySentence)}
            debugExpandedKeys={Object.keys(expandedNestedSentences).filter(k => !!expandedNestedSentences[k])}
            styles={styles}
          />
        </Section>

        <Section title="親が気にすべきこと">
          <ParagraphWithQA
            text={paragraphs[1]}
            onPressSentence={handleSentencePress}
            selectedSentence={selectedSentence}
            answersBySentence={answersBySentence}
            expandedSentences={expandedSentences}
            onToggleExpand={toggleSentenceExpand}
            onPressAnswerSentence={handleAnswerSentenceDeepDive}
            onLayoutSentence={registerSentenceLayout}
            childAnswersBySentence={childAnswersBySentence}
            expandedNestedSentences={expandedNestedSentences}
            onToggleNestedExpand={toggleNestedExpand}
            grandAnswersBySentence={grandAnswersBySentence}
            expandedGrandNested={expandedGrandNested}
            onToggleGrandNestedExpand={toggleGrandNestedExpand}
            onDebug={pushDebug}
            debugChildKeys={Object.keys(childAnswersBySentence)}
            debugExpandedKeys={Object.keys(expandedNestedSentences).filter(k => !!expandedNestedSentences[k])}
            styles={styles}
          />
        </Section>

        <Section title="実践ヒント">
          <ParagraphWithQA
            text={paragraphs[2]}
            onPressSentence={handleSentencePress}
            selectedSentence={selectedSentence}
            answersBySentence={answersBySentence}
            expandedSentences={expandedSentences}
            onToggleExpand={toggleSentenceExpand}
            onPressAnswerSentence={handleAnswerSentenceDeepDive}
            onLayoutSentence={registerSentenceLayout}
            childAnswersBySentence={childAnswersBySentence}
            expandedNestedSentences={expandedNestedSentences}
            onToggleNestedExpand={toggleNestedExpand}
            grandAnswersBySentence={grandAnswersBySentence}
            expandedGrandNested={expandedGrandNested}
            onToggleGrandNestedExpand={toggleGrandNestedExpand}
            onDebug={pushDebug}
            debugChildKeys={Object.keys(childAnswersBySentence)}
            debugExpandedKeys={Object.keys(expandedNestedSentences).filter(k => !!expandedNestedSentences[k])}
            styles={styles}
          />
        </Section>

        <Section title="親へのメッセージ">
          <ParagraphWithQA
            text={paragraphs[3]}
            onPressSentence={handleSentencePress}
            selectedSentence={selectedSentence}
            answersBySentence={answersBySentence}
            expandedSentences={expandedSentences}
            onToggleExpand={toggleSentenceExpand}
            onPressAnswerSentence={handleAnswerSentenceDeepDive}
            onLayoutSentence={registerSentenceLayout}
            childAnswersBySentence={childAnswersBySentence}
            expandedNestedSentences={expandedNestedSentences}
            onToggleNestedExpand={toggleNestedExpand}
            grandAnswersBySentence={grandAnswersBySentence}
            expandedGrandNested={expandedGrandNested}
            onToggleGrandNestedExpand={toggleGrandNestedExpand}
            onDebug={pushDebug}
            debugChildKeys={Object.keys(childAnswersBySentence)}
            debugExpandedKeys={Object.keys(expandedNestedSentences).filter(k => !!expandedNestedSentences[k])}
            styles={styles}
          />
        </Section>
      </ScrollView>

      {/* 下部質問入力バー */}
      <View style={styles.inputBar}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder={selectedSentence ? 'この文章について、知りたいことを入力…' : '月齢に関する質問を入力…'}
          value={question}
          onChangeText={setQuestion}
          multiline
          numberOfLines={2}
          maxLength={500}
        />
        <TouchableOpacity style={styles.sendButton} onPress={handleSend} disabled={isAsking}>
          {isAsking ? (
            <ActivityIndicator />
          ) : (
            <Text style={styles.sendButtonText}>送信</Text>
          )}
        </TouchableOpacity>
      </View>
      {debugLog ? (
        <View style={{ position: 'absolute', left: 12, right: 12, bottom: 12, backgroundColor: 'rgba(0,0,0,0.75)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 }}>
          <Text style={{ color: '#fff', fontSize: 12 }} selectable>{debugLog}</Text>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

// ---------- UI ヘルパー ----------
function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={{ marginTop: 6 }}>{children}</View>
    </View>
  );
}


function buildMonthlyBody(month) {
  // 簡易テンプレート：将来的にはサーバ生成に置換
  const base = `今月のポイントは、赤ちゃんの「反応」が一段と分かりやすくなることです。親の声・表情・触れ合いに対する反応が、これまでよりも濃く、持続します。`;
  const extra = month < 6
    ? `首と体幹の安定が進み、抱っこのバリエーションも増えます。短時間のうつ伏せ遊びや、ガラガラ等の簡単なおもちゃへの反応を観察してみましょう。`
    : month < 12
    ? `寝返り〜お座り〜つかまり立ちと運動の幅が広がる時期。安全確保のために、家具の角や床環境を点検しましょう。離乳食では鉄分とたんぱく質を意識できると◎。`
    : `言葉やジェスチャーの理解が進み、簡単な指示に反応したり真似を楽しんだりします。遊びの中に「言葉の交換」を少しずつ増やしていきましょう。`;
  return `${base}${extra}`;
}

// ---------- styles ----------
const styles = StyleSheet.create({
  header: {
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 8,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  headerTitle: { fontSize: 18, fontWeight: '800', color: '#333' },
  headerSubtitle: { marginTop: 6, fontSize: 13, color: '#666', lineHeight: 18 },

  content: { padding: 16, paddingBottom: 32 },
  section: { marginBottom: 18 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#333' },
  paragraphSentence: { fontSize: 15, color: '#333', lineHeight: 24, paddingVertical: 2 },
  selectedSentence: { backgroundColor: '#FFF5D6', borderRadius: 6, paddingHorizontal: 4 },

  pinBlock: {
    marginLeft: 6,
    marginBottom: 8,
    backgroundColor: '#F8FAFF',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E1E8FF',
  },
  pinHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  pinIcon: { fontSize: 12, marginRight: 6 },
  pinSummary: { flex: 1, fontSize: 12, color: '#334' },
  pinToggle: { fontSize: 12, color: '#3B6EF5', marginLeft: 8 },
  pinBody: { paddingHorizontal: 10, paddingBottom: 8 },
  qaItem: { marginTop: 6 },
  qaQ: { fontSize: 12, color: '#333' },
  qaA: { fontSize: 12, color: '#555', marginTop: 2, lineHeight: 18 },
  pinMore: { marginTop: 6, fontSize: 11, color: '#666' },

  nestedBlock: {
    marginLeft: 14,
    marginTop: 4,
    marginBottom: 6,
    backgroundColor: '#FDFBFF',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E9E0FF',
  },
  nestedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  nestedIcon: { fontSize: 12, marginRight: 6 },
  nestedSummary: { flex: 1, fontSize: 12, color: '#334' },
  nestedToggle: { fontSize: 12, color: '#6C54FF', marginLeft: 8 },
  nestedBody: { paddingHorizontal: 10, paddingBottom: 8 },
  qaItemNested: { marginTop: 6 },

  contextBar: {
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FAFAFA',
  },
  contextText: { fontSize: 12, color: '#555' },

  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    backgroundColor: '#fff',
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#F6F6F6',
    borderRadius: 10,
  },
  sendButton: {
    marginLeft: 8,
    backgroundColor: '#FF7A59',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  sendButtonText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  answerSentence: { fontSize: 14, color: '#333', lineHeight: 22, paddingVertical: 3 },
});


// --- PATCH: QA answer rendering: use Markdown instead of plain Text ---
// (You must update the code inside the renderParagraph or mapping over qaList in the component that renders QAs.)
// This is a hint for the developer: In the component that renders each QA item, replace:
//   <Text style={styles.qaA}>{qa.answer}</Text>
// with:
//   <Markdown style={{ body: styles.qaA }}>
//     {qa.answer}
//   </Markdown>