import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, Image, Modal, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getFirestore, collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  const [plans, setPlans] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isPlanning, setIsPlanning] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(null);

  const db = getFirestore();
  const auth = getAuth();
  const functions = useMemo(() => getFunctions(getApp(), 'asia-northeast1'), []);
  const planDayFromUrl = useMemo(() => httpsCallable(functions, 'planDayFromUrl', { timeout: 540000 }), [functions]);

  useEffect(() => {
    let isMounted = true;

    (async () => {
      try {
        // 1) 必ず匿名認証して UID を確定させる
        let user = auth.currentUser;
        if (!user) {
          console.log('[auth] No current user. Signing in anonymously...');
          await signInAnonymously(auth);
          user = auth.currentUser;
        }
        if (!user) {
          console.warn('[auth] Anonymous sign-in failed. Skip subscribing.');
          if (isMounted) setIsLoading(false);
          return;
        }

        // 2) ステータスの監視（進行中/完了/エラー）
        const unsubStatus = onSnapshot(
          // users/{uid} ドキュメントの planGenerationStatus を監視
          // eslint-disable-next-line no-undef
          require('firebase/firestore').doc(db, 'users', user.uid),
          (docSnap) => {
            const status = docSnap.data()?.planGenerationStatus ?? null;
            setIsPlanning(status === 'in_progress' ? 'running' : null);
          },
          (err) => console.warn('[firestore] status onSnapshot error:', err)
        );

        // 3) 候補プラン一覧の購読
        console.log(`Firestoreからプランを取得します (user: ${user.uid})`);
        const plansQuery = query(
          collection(db, 'users', user.uid, 'suggestedPlans'),
          orderBy('createdAt', 'desc')
        );
        const unsubPlans = onSnapshot(
          plansQuery,
          (snapshot) => {
            const plansData = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
            console.log(`[firestore] suggestedPlans -> ${plansData.length} docs`);
            if (isMounted) {
              setPlans(plansData);
              setIsLoading(false);
            }
          },
          (error) => {
            console.error('[firestore] suggestedPlans onSnapshot error:', error);
            if (isMounted) setIsLoading(false);
          }
        );

        // 4) クリーンアップ
        return () => {
          try { unsubPlans && unsubPlans(); } catch (_) {}
          try { unsubStatus && unsubStatus(); } catch (_) {}
        };
      } catch (e) {
        console.error('[auth/firestore] init error:', e);
        if (isMounted) setIsLoading(false);
      }
    })();

    return () => { isMounted = false; };
  }, [auth, db]);
  
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
});

export default SuggestedPlansScreen;
