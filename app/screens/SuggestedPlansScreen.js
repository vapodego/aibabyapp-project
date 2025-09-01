import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, Image, Modal, ScrollView, Pressable, Dimensions, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getFirestore, collection, onSnapshot, query, orderBy, doc, getDocs, limit, setDoc, serverTimestamp } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SUGGESTED_UNREAD_BY_FLAG } from '../config/featureFlags';
import { useRoute, useFocusEffect } from '@react-navigation/native';
// import mockPlans from '../mock/suggestedPlans.js'; // ダミーデータはもう不要

// --- ヘルパーコンポーネント ---
// 値が string / array / object でも安全に描画するユーティリティ
const renderDetailValue = (value, textStyle) => {
  if (value == null) return null;
  // 文字列ならそのまま
  if (typeof value === 'string') {
    return <Text style={textStyle}>{value}</Text>;
  }
  // 配列なら箇条書き
  if (Array.isArray(value)) {
    return (
      <View style={{ gap: 6 }}>
        {value.map((item, idx) => (
          <Text key={idx} style={textStyle}>• {String(item)}</Text>
        ))}
      </View>
    );
  }
  // オブジェクトなら key: value で列挙
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return (
      <View style={{ gap: 6 }}>
        {entries.map(([k, v]) => (
          <Text key={String(k)} style={textStyle}>{String(k)}：{typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : JSON.stringify(v)}</Text>
        ))}
      </View>
    );
  }
  // それ以外は文字列化
  return <Text style={textStyle}>{String(value)}</Text>;
};

const DetailSection = ({ icon, title, children }) => (
  <View style={styles.detailSection}>
    <View style={styles.detailSectionHeader}>
      <Ionicons name={icon} size={20} color="#FF6347" />
      <Text style={styles.detailSectionTitle}>{title}</Text>
    </View>
    <View style={styles.detailSectionContent}>{children}</View>
  </View>
);

const SuggestedPlansScreen = ({ navigation }) => {
  const route = useRoute();

  const [plans, setPlans] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isPlanning, setIsPlanning] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [selectedPlanRunId, setSelectedPlanRunId] = useState(null);
  const [latestRunId, setLatestRunId] = useState(null);
  const latestRunIdRef = useRef(null);
  useEffect(() => { latestRunIdRef.current = latestRunId; }, [latestRunId]);
  const [viewingRunId, setViewingRunId] = useState(null);
  const [recentRuns, setRecentRuns] = useState([]); // 過去のラン（最新含む上位）

  const [expandedRunIds, setExpandedRunIds] = useState([]); // 開いている runId の配列
  const [expandedPlansMap, setExpandedPlansMap] = useState({}); // runId -> plans[]
  const expandedUnsubsRef = useRef({}); // runId -> unsubscribe fn
  const toggleExpandRun = async (runId) => {
    try {
      const isOpen = expandedRunIds.includes(runId);
      if (isOpen) {
        // 閉じる: 監視解除 & データ破棄
        const unsub = expandedUnsubsRef.current[runId];
        if (typeof unsub === 'function') {
          try { unsub(); } catch (_) {}
        }
        delete expandedUnsubsRef.current[runId];
        setExpandedPlansMap((prev) => {
          const next = { ...prev };
          delete next[runId];
          return next;
        });
        setExpandedRunIds((prev) => prev.filter((id) => id !== runId));
        return;
      }

      // 開く: 初回だけ購読を開始
      const user = auth.currentUser || (await signInAnonymously(auth).then(() => auth.currentUser));
      if (!user) return;
      const plansQuery = query(
        collection(db, 'users', user.uid, 'planRuns', runId, 'suggestedPlans'),
        orderBy('createdAt', 'desc')
      );
      const unsub = onSnapshot(
        plansQuery,
        (snapshot) => {
          const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
          setExpandedPlansMap((prev) => ({ ...prev, [runId]: data }));
        },
        (err) => console.warn('[firestore] expanded run onSnapshot error:', err)
      );
      expandedUnsubsRef.current[runId] = unsub;
      setExpandedRunIds((prev) => [...prev, runId]);
    } catch (e) {
      console.warn('[toggleExpandRun] error:', e);
    }
  };

  const renderPastRunsFooter = () => {
    if (!recentRuns || recentRuns.length === 0) return null;
    const items = (recentRuns || []).filter(r => r.id !== latestRunId);
    if (items.length === 0) return null;
    return (
      <View style={styles.historyFooter}>
        <Text style={styles.pastFooterTitle}>🕰️ 過去のプラン</Text>
        {items.map((run) => {
          const createdAtText = run?.createdAt?.toDate ? run.createdAt.toDate().toLocaleString() : run.id;
          const isOpen = expandedRunIds.includes(run.id);
          const plansForRun = expandedPlansMap[run.id];
          return (
            <View key={run.id} style={styles.runCard}>
              <TouchableOpacity style={styles.runHeader} onPress={() => toggleExpandRun(run.id)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.runHeaderTitle}>{createdAtText}</Text>
                  <Text style={styles.runHeaderSub}>候補: {run.suggestedCount ?? '—'} / ステータス: {run.status ?? '—'}</Text>
                </View>
                <Ionicons name={isOpen ? 'chevron-down' : 'chevron-forward'} size={20} color="#666" />
              </TouchableOpacity>

              {isOpen && (
                <View style={styles.expandedList}>
                  {!plansForRun ? (
                    <Text style={styles.loadingText}>読み込み中...</Text>
                  ) : plansForRun.length === 0 ? (
                    <Text style={styles.loadingText}>プランがありません</Text>
                  ) : (
                    plansForRun.map((p) => (
                      <View key={p.id} style={styles.smallPlanCard}>
                        <Image source={{ uri: p.imageUrl || 'https://placehold.co/600x400' }} style={styles.smallCardImage} />
                        <View style={styles.smallCardBody}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                            <Text style={styles.smallPlanTitle} numberOfLines={1}>{p.planName}</Text>
                            {SUGGESTED_UNREAD_BY_FLAG && !p.readAt ? (
                              <View style={[styles.newPill, { marginLeft: 6 }]}><Text style={styles.newPillText}>NEW</Text></View>
                            ) : null}
                          </View>
                          <Text style={styles.smallPlanEvent} numberOfLines={1}>{p.eventName}</Text>
                          <Text style={styles.smallPlanSummary} numberOfLines={2}>{p.summary}</Text>
                          <TouchableOpacity style={styles.smallDetailBtn} onPress={() => handleShowDetails(p, run.id)}>
                            <Text style={styles.smallDetailBtnText}>詳細を見る →</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ))
                  )}
                </View>
              )}
            </View>
          );
        })}
      </View>
    );
  };
  useEffect(() => {
    return () => {
      const m = expandedUnsubsRef.current || {};
      Object.keys(m).forEach((k) => {
        const unsub = m[k];
        if (typeof unsub === 'function') {
          try { unsub(); } catch (_) {}
        }
      });
      expandedUnsubsRef.current = {};
    };
  }, []);

  const db = getFirestore();
  const auth = getAuth();
  const functions = useMemo(() => getFunctions(getApp(), 'asia-northeast1'), []);
  const planDayFromUrl = useMemo(() => httpsCallable(functions, 'planDayFromUrl', { timeout: 540000 }), [functions]);

  // Edge fade (disabled if expo-linear-gradient is not installed). Keeping off to avoid runtime require issues.
  const LinearGradient = null;

  // Dimensions for horizontal rail
  const FEATURED_N = 5;
  const screenW = Dimensions.get('window').width;
  const CARD_W = Math.round(screenW * 0.78);
  const CARD_SPACING = 12;

  // Collapsing hero (fade-only): tracks scroll for opacity interpolation
  const scrollY = useRef(new Animated.Value(0)).current;
  const [heroMinH, setHeroMinH] = useState(0); // measured hero height
  const fadeRange = Math.max(100, (heroMinH || 160));
  const clampedY = Animated.diffClamp(scrollY, 0, fadeRange);
  const heroOpacity = clampedY.interpolate({ inputRange: [0, fadeRange], outputRange: [1, 0], extrapolate: 'clamp' });

  // Past plans flattened (from recent runs except latest)
  const [pastFlatPlans, setPastFlatPlans] = useState([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let user = auth.currentUser;
        if (!user) { try { await signInAnonymously(auth); user = auth.currentUser; } catch (_) { /* ignore */ } }
        const uid = user?.uid;
        if (!uid) { setPastFlatPlans([]); return; }
        const runs = (recentRuns || []).filter(r => r && r.id && r.id !== latestRunId);
        if (!runs.length) { setPastFlatPlans([]); return; }
        // Fetch plans for each run (desc)
        const plansArrays = await Promise.all(runs.map(async (run) => {
          try {
            const qref = query(collection(db, 'users', uid, 'planRuns', run.id, 'suggestedPlans'), orderBy('createdAt', 'desc'));
            const snap = await getDocs(qref);
            return snap.docs.map(d => ({ id: d.id, runId: run.id, ...d.data() }));
          } catch (e) {
            console.warn('[pastFlat] fetch failed for run', run.id, e?.message || e);
            return [];
          }
        }));
        const flat = plansArrays.flat().filter(p => !p.placeholder);
        // Deduplicate by url if present, else by planName+eventName
        const seen = new Set();
        const out = [];
        for (const p of flat) {
          const key = p.url || `${p.planName}__${p.eventName}`;
          if (key && !seen.has(key)) { seen.add(key); out.push(p); }
        }
        if (!cancelled) setPastFlatPlans(out);
      } catch (e) {
        if (!cancelled) setPastFlatPlans([]);
      }
    })();
    return () => { cancelled = true; };
  }, [auth, db, recentRuns, latestRunId]);

  // Mark last opened time for unread badge logic (Phase 5)
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        try {
          let user = auth.currentUser;
          if (!user) { await signInAnonymously(auth); user = auth.currentUser; }
          if (!user || !active) return;
          // Always update timestamp for fallback/analytics
          await setDoc(doc(db, 'users', user.uid), { suggestedLastOpenedAt: serverTimestamp() }, { merge: true });
        } catch (e) {
          console.warn('[SuggestedPlans] mark last opened failed:', e?.message || e);
        }
      })();
      return () => { active = false; };
    }, [auth, db])
  );

  // Mark a single plan as read when user taps "詳細を見る"
  const markPlanRead = useCallback(async (plan) => {
    try {
      if (!SUGGESTED_UNREAD_BY_FLAG) return; // only in flag mode
      let user = auth.currentUser;
      if (!user) { await signInAnonymously(auth); user = auth.currentUser; }
      if (!user) return;
      const uid = user.uid;
      const runId = viewingRunId || latestRunId || null;
      if (plan?.id) {
        if (runId) {
          try { await setDoc(doc(db, 'users', uid, 'planRuns', runId, 'suggestedPlans', String(plan.id)), { readAt: serverTimestamp() }, { merge: true }); } catch (_) {}
        }
        try { await setDoc(doc(db, 'users', uid, 'suggestedPlans', String(plan.id)), { readAt: serverTimestamp() }, { merge: true }); } catch (_) {}
      }
      // Optimistic UI
      setPlans((prev) => prev.map(p => (p.id === plan.id ? { ...p, readAt: p.readAt || new Date() } : p)));
      setExpandedPlansMap((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach(k => { next[k] = (next[k] || []).map(p => (p.id === plan.id ? { ...p, readAt: p.readAt || new Date() } : p)); });
        return next;
      });
    } catch (e) {
      console.warn('[SuggestedPlans] markPlanRead failed:', e?.message || e);
    }
  }, [auth, db, viewingRunId, latestRunId]);

  useEffect(() => {
    let isMounted = true;
    let unsubPlans = null;
    let unsubStatus = null;
    let unsubRuns = null;

    (async () => {
      try {
        // 1) 認証
        let user = auth.currentUser;
        if (!user) {
          await signInAnonymously(auth);
          user = auth.currentUser;
        }
        if (!user) { if (isMounted) setIsLoading(false); return; }

        // 2) 最新の runId を一度取得
        const runsQ = query(collection(db, 'users', user.uid, 'planRuns'), orderBy('createdAt', 'desc'), limit(1));
        const latestSnap = await getDocs(runsQ);
        const latestId = latestSnap.docs[0]?.id || null;
        if (isMounted) setLatestRunId((prev) => prev || latestId);

        // 3) route から runId が来たら優先して viewingRunId に反映
        const paramRunId = route?.params?.runId || null;
        if (paramRunId && paramRunId !== viewingRunId) {
          if (isMounted) setViewingRunId(paramRunId);
        } else if (!viewingRunId && latestId) {
          if (isMounted) setViewingRunId(latestId);
        }

        // 4) ステータス購読（常時）
        if (!unsubStatus) {
          unsubStatus = onSnapshot(doc(db, 'users', user.uid), (docSnap) => {
            const status = docSnap.data()?.planGenerationStatus ?? null;
            setIsPlanning(status === 'in_progress' ? 'running' : null);
          }, (err) => console.warn('[firestore] status onSnapshot error:', err));
        }

        // 5) 直近の runs を購読（インライン履歴）
        if (!unsubRuns) {
          const recentRunsQ = query(collection(db, 'users', user.uid, 'planRuns'), orderBy('createdAt', 'desc'), limit(6));
          unsubRuns = onSnapshot(recentRunsQ, (snap) => {
            const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            if (isMounted) setRecentRuns(items);
            // Keep latestRunId synced with newest snapshot result
            const newLatestId = items[0]?.id || null;
            const prevLatest = latestRunIdRef.current;
            if (newLatestId && newLatestId !== prevLatest) {
              if (isMounted) setLatestRunId(newLatestId);
              // If viewing latest or not set, follow to the new latest
              if (isMounted) setViewingRunId((cur) => (!cur || cur === prevLatest) ? newLatestId : cur);
            }
          }, (err) => console.warn('[firestore] planRuns onSnapshot error:', err));
        }

        // 6) 表示対象 runId のプラン購読（viewingRunId の変化で張り替え）
        if (unsubPlans) { try { unsubPlans(); } catch (_) {} }
        const uid = user.uid;
        if (viewingRunId) {
          const plansQuery = query(collection(db, 'users', uid, 'planRuns', viewingRunId, 'suggestedPlans'), orderBy('createdAt', 'desc'));
          unsubPlans = onSnapshot(plansQuery, (snapshot) => {
            const plansData = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
            if (isMounted) { setPlans(plansData); setIsLoading(false); }
          }, (error) => { console.error('[firestore] run suggestedPlans onSnapshot error:', error); if (isMounted) setIsLoading(false); });
        } else {
          const rootQuery = query(collection(db, 'users', uid, 'suggestedPlans'), orderBy('createdAt', 'desc'));
          unsubPlans = onSnapshot(rootQuery, (snapshot) => {
            const plansData = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
            if (isMounted) { setPlans(plansData); setIsLoading(false); }
          }, (error) => { console.error('[firestore] root suggestedPlans onSnapshot error:', error); if (isMounted) setIsLoading(false); });
        }
      } catch (e) {
        console.error('[auth/firestore] init error:', e);
        if (isMounted) setIsLoading(false);
      }
    })();

    return () => {
      isMounted = false;
      try { unsubPlans && unsubPlans(); } catch (_) {}
      try { unsubStatus && unsubStatus(); } catch (_) {}
      try { unsubRuns && unsubRuns(); } catch (_) {}
    };
  // viewingRunId / route の変化で再実行
  }, [auth, db, viewingRunId, route?.params?.runId]);
  
  const handleShowDetails = (plan, runId = null) => {
    if (plan) { markPlanRead(plan, runId); }
    setSelectedPlan(plan);
    setSelectedPlanRunId(runId);
    setModalVisible(true);
  };

  const handleSelectPlan = async () => {
    if (!selectedPlan?.url) {
      Alert.alert("エラー", "プラン情報が不完全です。");
      return;
    }
    setIsPlanning(selectedPlan.url);
    try {
      // Mark this plan as read (again, in case modal entry skipped it)
      await markPlanRead(selectedPlan, selectedPlanRunId);
      let user = auth.currentUser;
      if (!user) {
        console.log("ユーザーが未認証のため、匿名サインインを試みます...");
        await signInAnonymously(auth);
        user = auth.currentUser;
      }
      if (!user) {
        throw new Error('認証に失敗しました。アプリを再起動してみてください。');
      }
      
      console.log(`認証OK (UID: ${user.uid})。dayPlannerを呼び出します...`);
      const originAddress = await AsyncStorage.getItem('user_location');
      const result = await planDayFromUrl({ 
          eventUrl: selectedPlan.url, 
          originAddress: originAddress 
      });

      if (result.data.status === 'success' && result.data.plan) {
        setModalVisible(false);
        navigation.navigate('DayPlan', { detailedPlan: result.data.plan });
      } else {
        throw new Error(result.data.message || '詳細プランの生成に失敗しました。');
      }
    } catch (error) {
      Alert.alert("エラー", `詳細プランの生成に失敗しました: ${error.message}`);
    } finally {
      setIsPlanning(null);
    }
  };

  // Build lists BEFORE any early return to keep hook order stable
  const mergedPlans = useMemo(() => [
    ...plans.slice(FEATURED_N),
    ...pastFlatPlans,
  ], [plans, pastFlatPlans]);
  const listData = useMemo(() => [{ __type: 'rail' }, { __type: 'listTitle' }, ...mergedPlans], [mergedPlans]);

  if (isLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.pageHeader}>
          <Text style={styles.pageTitle}>✨ 提案</Text>
        </View>
        <View style={styles.introCard}> 
          <Text style={styles.introText}>あなたの関心や移動手段に合わせて、AIが「今日行けるお出かけプラン」を提案します。</Text>
          <View style={[styles.ctaButton, { opacity: 0.6, alignSelf: 'flex-start' }]}>
            <Ionicons name="map-outline" size={20} color="#fff" />
            <Text style={styles.ctaButtonText}>AIとお出かけプランを立てる</Text>
          </View>
        </View>
        {/* Simple shimmer-like placeholders */}
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <Text style={styles.sectionTitle}>🆕 最新のAIプラン</Text>
          <View style={{ height: 200, marginTop: 8 }}>
            <ShimmerRow count={3} width={CARD_W} height={180} spacing={CARD_SPACING} />
          </View>
        </View>
        <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
          <ShimmerList count={3} />
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Animated.FlatList
        data={listData}
        keyExtractor={(item, index) => item.__type ? `${item.__type}-${index}` : `${item.url || item.id || 'plan'}-${index}`}
        stickyHeaderIndices={[1]}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: false })}
        scrollEventThrottle={16}
        contentContainerStyle={styles.listContainer}
        ListHeaderComponent={(
          <Animated.View style={styles.heroWrap}> 
            <Animated.View style={[styles.heroGlass, { opacity: heroOpacity }]} onLayout={(e) => { if (!heroMinH) setHeroMinH(e.nativeEvent.layout.height); }}>
              <Text style={styles.heroKicker}>週末のプランを作成しよう！</Text>
              <Animated.View style={{ opacity: heroOpacity, marginTop: 2 }}>
                <View style={styles.stepRow}>
                  <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>1</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.stepTitle}>お出かけプランを立てる</Text>
                    <TouchableOpacity style={[styles.ctaButton, !!isPlanning && { opacity: 0.7 }]} onPress={() => navigation.navigate('Plan')} disabled={!!isPlanning}>
                      <Ionicons name="map-outline" size={20} color="#fff" />
                      <Text style={styles.ctaButtonText}>{isPlanning ? '生成中…' : 'AIとお出かけプランを立てる'}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={styles.stepDivider} />
                <View style={styles.stepRow}>
                  <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>2</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.stepTitle}>生成されたプランを見て決定しよう</Text>
                    <TouchableOpacity style={[styles.ctaButton, styles.decideButton]} activeOpacity={0.8} onPress={() => { /* no-op */ }}>
                      <Ionicons name="checkmark-circle" size={20} color="#fff" />
                      <Text style={styles.ctaButtonText}>このプランに決定！</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </Animated.View>
            </Animated.View>
          </Animated.View>
        )}
        renderItem={({ item }) => {
          if (item.__type === 'rail') {
            return (
              <View style={styles.railSticky}>
                <View style={styles.railTitleWrap}>
                  <Text style={styles.sectionTitle}>🆕 最新のAIプラン</Text>
                </View>
                <View style={styles.railBody}>
                  <FlatList
                    data={plans.slice(0, FEATURED_N)}
                    keyExtractor={(it, idx) => `featured-${it.url || it.id || idx}`}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    snapToInterval={CARD_W + CARD_SPACING}
                    decelerationRate="fast"
                    snapToAlignment="start"
                    contentContainerStyle={{ paddingHorizontal: 16 }}
                    ItemSeparatorComponent={() => <View style={{ width: CARD_SPACING }} />}
                    renderItem={({ item: it }) => (
                      <TouchableOpacity activeOpacity={0.85} onPress={() => handleShowDetails(it, viewingRunId)}>
                        <View style={[styles.featuredCard, { width: CARD_W }]}>
                          <Image source={{ uri: it.imageUrl || 'https://placehold.co/600x400' }} style={styles.featuredImage} />
                          <View style={styles.featuredBody}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                              <Text style={styles.featuredTitle} numberOfLines={1}>{it.planName}</Text>
                              {SUGGESTED_UNREAD_BY_FLAG && !it.readAt ? (
                                <View style={[styles.newPill, { marginLeft: 6 }]}><Text style={styles.newPillText}>NEW</Text></View>
                              ) : null}
                            </View>
                            <Text style={styles.featuredSub} numberOfLines={1}>{it.eventName}</Text>
                          </View>
                        </View>
                      </TouchableOpacity>
                    )}
                  />
                </View>
              </View>
            );
          }
          if (item.__type === 'listTitle') {
            return (
              <View style={{ paddingHorizontal: 16, paddingBottom: 8, backgroundColor: '#F7F7F7' }}>
                <Text style={styles.sectionTitle}>📋 プラン一覧</Text>
              </View>
            );
          }
          // Plan rows
          const p = item;
          return (
            <TouchableOpacity activeOpacity={0.85} onPress={() => handleShowDetails(p, p.runId || viewingRunId)}>
              <View style={styles.compactRow}>
                {p.imageUrl ? (
                  <Image source={{ uri: p.imageUrl }} style={styles.thumb} />
                ) : (
                  <View style={styles.thumbPlaceholder}><Ionicons name="image-outline" size={20} color="#999" /></View>
                )}
                <View style={styles.compactContent}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Text style={styles.compactTitle} numberOfLines={1}>{p.planName}</Text>
                    {SUGGESTED_UNREAD_BY_FLAG && !p.readAt ? (
                      <View style={[styles.newPill, { marginLeft: 6 }]}><Text style={styles.newPillText}>NEW</Text></View>
                    ) : null}
                  </View>
                  <Text style={styles.compactPreview} numberOfLines={2}>{p.summary}</Text>
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={(
          <View style={styles.centered}>
            <Text style={styles.emptyText}>プラン候補はまだありません。</Text>
            <Text style={styles.emptySubText}>プランを生成すると、ここに表示されます。</Text>
          </View>
        )}
      />

      {selectedPlan && (
        <Modal
          animationType="slide"
          transparent={true}
          visible={modalVisible}
          onRequestClose={() => setModalVisible(false)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setModalVisible(false)} />
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <View style={styles.dragHandle} />
            </View>
            <ScrollView style={styles.modalScrollView}>
              <Image source={{ uri: selectedPlan.imageUrl || 'https://placehold.co/600x400' }} style={styles.modalImage} />
              <View style={styles.modalContent}>
                <Text style={styles.modalPlanName}>{selectedPlan.planName}</Text>
                <Text style={styles.modalEventName}>{selectedPlan.eventName}</Text>
                {selectedPlan.date && <Text style={styles.modalDate}>日程: {selectedPlan.date}</Text>}
                {selectedPlan.location?.name && <Text style={styles.modalLocation}>場所: {selectedPlan.location.name}</Text>}
                <Text style={styles.modalSummary}>{selectedPlan.summary}</Text>

                {selectedPlan.strategicGuide && (
                  <>
                    <DetailSection icon="heart-outline" title="このプランがあなたに最適な理由">
                      {renderDetailValue(selectedPlan.strategicGuide.whySpecial, styles.detailText)}
                    </DetailSection>
                    <DetailSection icon="navigate-circle-outline" title="アクセス・基本情報">
                      {renderDetailValue(selectedPlan.strategicGuide.logistics, styles.detailText)}
                    </DetailSection>
                    <DetailSection icon="happy-outline" title="赤ちゃん安心情報">
                      {renderDetailValue(selectedPlan.strategicGuide.babyInfo, styles.detailText)}
                    </DetailSection>
                    <DetailSection icon="list-outline" title="モデルプラン">
                      {renderDetailValue(selectedPlan.strategicGuide.sampleItinerary, styles.detailText)}
                    </DetailSection>
                    <DetailSection icon="briefcase-outline" title="持ち物リスト">
                      {renderDetailValue(selectedPlan.strategicGuide.packingList, styles.detailText)}
                    </DetailSection>
                    <DetailSection icon="rainy-outline" title="もしもの時の代替案">
                      {renderDetailValue(selectedPlan.alternativePlan, styles.detailText)}
                    </DetailSection>
                  </>
                )}

                <TouchableOpacity 
                  style={styles.modalDecisionButton} 
                  onPress={handleSelectPlan}
                  disabled={!!isPlanning}
                >
                  {isPlanning ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.modalButtonText}>このプランに決定！</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  container: { flex: 1, backgroundColor: '#F7F7F7' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 16, backgroundColor: 'white', borderBottomWidth: 1, borderBottomColor: '#EEE' },
  backButton: { padding: 4 },
  title: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  pageHeader: { paddingHorizontal: 16, paddingTop: 8 },
  pageTitle: { fontSize: 28, fontWeight: '900', color: '#222' },
  heroWrap: { marginHorizontal: -16, paddingTop: 4, marginBottom: 8, overflow: 'hidden' },
  heroGlass: { marginHorizontal: 16, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)', backgroundColor: 'rgba(255,255,255,0.85)', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  heroTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroChip: { backgroundColor: '#0EA5E9', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10 },
  heroChipText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  heroSub: { color: '#555', fontSize: 13, marginTop: 2 },
  heroKicker: { fontSize: 14, fontWeight: '700', color: '#333', marginBottom: 4 },
  introCard: { backgroundColor: '#FFFFFF', margin: 16, marginBottom: 8, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: '#EEE' },
  introTitle: { fontSize: 14, fontWeight: '800', color: '#333', marginBottom: 6 },
  introText: { fontSize: 13, color: '#555', lineHeight: 20, marginBottom: 10 },
  ctaButton: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FF6347', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  ctaButtonText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  decideButton: { marginTop: 4, backgroundColor: '#22C55E' },
  emptyText: { fontSize: 18, color: 'gray', textAlign: 'center' },
  emptySubText: { fontSize: 14, color: '#A0A0A0', marginTop: 8, textAlign: 'center' },
  listContainer: { padding: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: '#333' },
  compactRow: {
    flexDirection: 'row', alignItems: 'center',
    marginBottom: 12,
    backgroundColor: '#FFF',
    borderRadius: 12,
    borderWidth: 1, borderColor: '#EEE',
    overflow: 'hidden'
  },
  thumb: { width: 92, height: 92, backgroundColor: '#f2f2f2' },
  thumbPlaceholder: { width: 92, height: 92, backgroundColor: '#f2f2f2', alignItems: 'center', justifyContent: 'center' },
  compactContent: { flex: 1, minHeight: 92, justifyContent: 'center', paddingHorizontal: 12 },
  compactTitle: { fontSize: 15, fontWeight: '800', color: '#222' },
  compactPreview: { marginTop: 4, fontSize: 12, color: '#555' },
  featuredCard: { backgroundColor: '#FFF', borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#EEE' },
  featuredImage: { width: '100%', height: 140, backgroundColor: '#f0f0f0' },
  featuredBody: { padding: 10 },
  featuredTitle: { fontSize: 16, fontWeight: '800', color: '#222' },
  featuredSub: { fontSize: 12, color: '#666', marginTop: 2 },
  railSticky: { backgroundColor: '#F7F7F7', paddingBottom: 8 },
  railTitleWrap: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8, backgroundColor: '#F7F7F7' },
  railBody: { height: 210, backgroundColor: '#F7F7F7' },
  fadeLeft: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 24 },
  fadeRight: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 24 },
  planCard: { backgroundColor: 'white', borderRadius: 16, marginBottom: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 5, overflow: 'hidden' },
  cardImage: { width: '100%', height: 180 },
  cardContent: { padding: 16 },
  planTitle: { fontSize: 22, fontWeight: 'bold', color: '#333', marginBottom: 4 },
  planEvent: { fontSize: 16, color: 'gray', marginBottom: 12 },
  planSummary: { fontSize: 14, color: '#666', lineHeight: 21, marginBottom: 16 },
  decisionButton: { backgroundColor: '#007AFF', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  buttonText: { color: 'white', fontSize: 16, fontWeight: 'bold' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  modalContainer: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '85%', backgroundColor: '#F7F7F7', borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  modalHeader: { alignItems: 'center', paddingVertical: 12, backgroundColor: 'white' },
  dragHandle: { width: 40, height: 5, backgroundColor: '#ccc', borderRadius: 3 },
  modalScrollView: { flex: 1 },
  modalImage: { width: '100%', height: 220 },
  modalContent: { padding: 20 },
  modalPlanName: { fontSize: 26, fontWeight: 'bold', color: '#333', marginBottom: 8, textAlign: 'center' },
  modalEventName: { fontSize: 18, color: 'gray', marginBottom: 16, textAlign: 'center' },
  modalDate: { fontSize: 16, color: '#555', marginBottom: 4, textAlign: 'center' },
  modalLocation: { fontSize: 16, color: '#555', marginBottom: 24, textAlign: 'center', borderBottomWidth: 1, borderBottomColor: '#EEE', paddingBottom: 24 },
  modalSummary: { fontSize: 16, color: '#555', lineHeight: 26, marginBottom: 24, fontStyle: 'italic', textAlign: 'center' },
  modalDecisionButton: { backgroundColor: '#FF6347', paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginTop: 32, marginBottom: 40 },
  modalButtonText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
  detailSection: { backgroundColor: 'white', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#EFEFEF' },
  detailSectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, },
  detailSectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginLeft: 8 },
  detailSectionContent: { paddingLeft: 2 },
  detailText: { fontSize: 15, color: '#555', lineHeight: 24 },
  historyButton: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#EEE', borderRadius: 12 },
  historyButtonText: { fontSize: 12, fontWeight: '600', color: '#333' },
  switchBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#EEE' },
  switchBarText: { fontSize: 12, color: '#666' },
  switchButton: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#FFEEE9', borderRadius: 12 },
  switchButtonText: { fontSize: 12, color: '#FF6347', fontWeight: '600' },
  pastSection: { paddingHorizontal: 16, paddingVertical: 12 },
  pastTitle: { fontSize: 14, fontWeight: '700', color: '#333', marginBottom: 8 },
  pastItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, backgroundColor: '#FFF', borderRadius: 10, marginBottom: 8, borderWidth: 1, borderColor: '#EEE' },
  pastItemTitle: { fontSize: 13, fontWeight: '600', color: '#333' },
  pastItemSub: { fontSize: 12, color: '#666', marginTop: 2 },
  pastModalContainer: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '80%', backgroundColor: '#F7F7F7', borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  pastModalHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#EEE' },
  pastModalTitle: { fontSize: 16, fontWeight: '700', color: '#333' },
  historyFooter: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#EEE' },
  pastFooterTitle: { fontSize: 14, fontWeight: '700', color: '#333', marginBottom: 8, paddingHorizontal: 16 },
  runCard: { backgroundColor: '#FFF', borderRadius: 12, borderWidth: 1, borderColor: '#EEE', marginHorizontal: 16, marginBottom: 12, overflow: 'hidden' },
  runHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, backgroundColor: '#FAFAFA' },
  runHeaderTitle: { fontSize: 14, fontWeight: '700', color: '#333' },
  runHeaderSub: { fontSize: 12, color: '#666', marginTop: 2 },
  expandedList: { paddingHorizontal: 12, paddingBottom: 12, paddingTop: 8 },
  loadingText: { fontSize: 12, color: '#666', paddingVertical: 10, paddingHorizontal: 4 },
  smallPlanCard: { flexDirection: 'row', backgroundColor: '#FFF', borderWidth: 1, borderColor: '#EEE', borderRadius: 10, marginTop: 8, overflow: 'hidden' },
  smallCardImage: { width: 88, height: 88 },
  smallCardBody: { flex: 1, padding: 10 },
  smallPlanTitle: { fontSize: 14, fontWeight: '700', color: '#333' },
  smallPlanEvent: { fontSize: 12, color: '#777', marginTop: 2 },
  smallPlanSummary: { fontSize: 12, color: '#666', marginTop: 4 },
  smallDetailBtn: { alignSelf: 'flex-start', marginTop: 8, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#007AFF', borderRadius: 8 },
  smallDetailBtnText: { color: '#FFF', fontSize: 12, fontWeight: '700' },
  newPill: { marginLeft: 8, backgroundColor: '#FF3B30', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, alignSelf: 'flex-start' },
  newPillText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  // Steps UI
  stepRow: { flexDirection: 'row', alignItems: 'center', columnGap: 10, marginTop: 8 },
  stepBadge: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFE4DE', alignItems: 'center', justifyContent: 'center' },
  stepBadgeText: { color: '#FF6347', fontWeight: '800', fontSize: 12 },
  stepTitle: { fontSize: 13, fontWeight: '800', color: '#333', marginBottom: 6 },
  stepHint: { fontSize: 12, color: '#666' },
  stepDivider: { height: 1, backgroundColor: '#EEE', marginTop: 6 },
});

export default SuggestedPlansScreen; 
 
// --- Simple shimmer placeholders (pulse opacity) ---
function ShimmerRow({ count = 3, width = 280, height = 160, spacing = 12 }) {
  const items = new Array(count).fill(0);
  return (
    <View style={{ flexDirection: 'row', paddingHorizontal: 16 }}>
      {items.map((_, i) => (
        <PulseBlock key={i} style={{ width, height, marginRight: i === count - 1 ? 0 : spacing, borderRadius: 14 }} />
      ))}
    </View>
  );
}

function ShimmerList({ count = 3 }) {
  const items = new Array(count).fill(0);
  return (
    <View style={{ gap: 12 }}>
      {items.map((_, i) => (
        <PulseBlock key={i} style={{ height: 180, borderRadius: 16 }} />
      ))}
    </View>
  );
}

function PulseBlock({ style }) {
  const opacity = React.useRef(new Animated.Value(0.6)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.6, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={[{ backgroundColor: '#ECECEC', opacity }, style]} />;
}
