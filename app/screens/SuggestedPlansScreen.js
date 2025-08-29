import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, Image, Modal, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getFirestore, collection, onSnapshot, query, orderBy, doc, getDocs, limit, setDoc, serverTimestamp } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  const [latestRunId, setLatestRunId] = useState(null);
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
        <Text style={styles.pastFooterTitle}>過去のプラン</Text>
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
                          <Text style={styles.smallPlanTitle} numberOfLines={1}>{p.planName}</Text>
                          <Text style={styles.smallPlanEvent} numberOfLines={1}>{p.eventName}</Text>
                          <Text style={styles.smallPlanSummary} numberOfLines={2}>{p.summary}</Text>
                          <TouchableOpacity style={styles.smallDetailBtn} onPress={() => handleShowDetails(p)}>
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

  // Mark last opened time for unread badge logic (Phase 5)
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        try {
          let user = auth.currentUser;
          if (!user) { await signInAnonymously(auth); user = auth.currentUser; }
          if (!user || !active) return;
          await setDoc(doc(db, 'users', user.uid), { suggestedLastOpenedAt: serverTimestamp() }, { merge: true });
        } catch (e) {
          console.warn('[SuggestedPlans] mark last opened failed:', e?.message || e);
        }
      })();
      return () => { active = false; };
    }, [auth, db])
  );

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
  
  const handleShowDetails = (plan) => {
    setSelectedPlan(plan);
    setModalVisible(true);
  };

  const handleSelectPlan = async () => {
    if (!selectedPlan?.url) {
      Alert.alert("エラー", "プラン情報が不完全です。");
      return;
    }
    setIsPlanning(selectedPlan.url);
    try {
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

  if (isLoading) {
    return <View style={styles.centered}><ActivityIndicator size="large" /></View>;
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={28} color="#333" />
        </TouchableOpacity>
        <Text style={styles.title}>生成されたプラン候補</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={styles.switchBar}>
        <Text style={styles.switchBarText}>
          {viewingRunId && latestRunId && viewingRunId !== latestRunId ? '過去のプランを表示中' : '最新のプランを表示中'}
        </Text>
        {latestRunId && viewingRunId && viewingRunId !== latestRunId && (
          <TouchableOpacity onPress={() => setViewingRunId(latestRunId)} style={styles.switchButton}>
            <Text style={styles.switchButtonText}>最新を表示</Text>
          </TouchableOpacity>
        )}
      </View>

      {plans.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>プラン候補はまだありません。</Text>
          <Text style={styles.emptySubText}>プランを生成すると、ここに表示されます。</Text>
        </View>
      ) : (
        <FlatList
          data={plans}
          keyExtractor={(item, index) => `${item.url}-${index}`}
          contentContainerStyle={styles.listContainer}
          renderItem={({ item }) => (
            <View style={styles.planCard}>
              <Image source={{ uri: item.imageUrl || 'https://placehold.co/600x400' }} style={styles.cardImage} />
              <View style={styles.cardContent}>
                <Text style={styles.planTitle}>{item.planName}</Text>
                <Text style={styles.planEvent}>{item.eventName}</Text>
                <Text style={styles.planSummary} numberOfLines={3}>{item.summary}</Text>
                <TouchableOpacity 
                  style={styles.decisionButton} 
                  onPress={() => handleShowDetails(item)}
                >
                  <Text style={styles.buttonText}>詳細を見る →</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          ListFooterComponent={renderPastRunsFooter}
        />
      )}

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
  emptyText: { fontSize: 18, color: 'gray', textAlign: 'center' },
  emptySubText: { fontSize: 14, color: '#A0A0A0', marginTop: 8, textAlign: 'center' },
  listContainer: { padding: 16 },
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
});

export default SuggestedPlansScreen;
