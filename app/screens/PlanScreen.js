// PlanScreen.js (本番環境 強制接続モード)

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    Button,
    ActivityIndicator,
    Alert,
    ScrollView
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { getAuth, signInAnonymously } from 'firebase/auth';


const PlanScreen = ({ navigation }) => {
  const functions = useMemo(() => {
    const app = getApp();
    const funcs = getFunctions(app, 'asia-northeast1');
    
    // ▼▼▼【修正点】エミュレータ接続のロジックを一時的に無効化 ▼▼▼
    /*
    if (__DEV__) {
      try {
        connectFunctionsEmulator(funcs, "192.168.1.13", 5001);
        console.log("✅ Functions Emulatorに接続しました。");
      } catch (e) {
        console.warn("⚠️ Functions Emulatorへの接続に失敗しました:", e);
      }
    }
    */
    console.log("✅【強制本番モード】Functionsはクラウドに接続します。");
    // ▲▲▲【ここまで修正】▲▲▲
    return funcs;
  }, []);

  // 本番環境用の関数のみ使用
  const generatePlansProduction = useMemo(() => {
    return httpsCallable(functions, 'generatePlansOnCall');
  }, [functions]);

  const [interests, setInterests] = useState('');
  const [location, setLocation] = useState('');
  const [status, setStatus] = useState('idle');
  const [plans, setPlans] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadUserData = async () => {
      const savedLocation = await AsyncStorage.getItem('user_location');
      const savedInterests = await AsyncStorage.getItem('user_interests');
      if (savedLocation) setLocation(savedLocation);
      if (savedInterests) setInterests(savedInterests);
    };
    loadUserData();
  }, []);

const handleSearchPlans = async () => { // asyncになっていることを確認
    if (!location.trim() || !interests.trim()) {
      Alert.alert('入力エラー', 'お住まいの地域と興味・関心の両方を入力してください。');
      return;
    }

    setStatus('loading');
    setError(null);
    setPlans([]);

    try {
      // ▼▼▼【ここからが追加する認証ロジックです】▼▼▼
      const auth = getAuth();
      let user = auth.currentUser;

      // もしユーザーがログインしていなければ、匿名でサインインする
      if (!user) {
        console.log("ユーザーが未認証のため、匿名サインインを試みます...");
        await signInAnonymously(auth);
        user = auth.currentUser; // サインイン後に、もう一度ユーザー情報を取得
      }

      // それでもユーザー情報がなければ、処理を中断してエラーを表示
      if (!user) {
        throw new Error('認証に失敗しました。アプリを再起動してみてください。');
      }
      // ▲▲▲【ここまでが認証ロジックです】▲▲▲

      // 認証が成功したことを確認してから、Functionsを呼び出す
      console.log(`認証OK (UID: ${user.uid})。本番用関数(generatePlansOnCall)を呼び出します...`);
      const result = await generatePlansProduction({ location, interests });

      if (result.data.status === 'processing_started') {
        Alert.alert(
          '受付完了',
          'プランの生成を開始しました。完了次第、ホーム画面のボタンが変化してお知らせします。',
          [{ text: 'ホームに戻る', onPress: () => navigation.goBack() }]
        );
        setStatus('idle');
      } else {
        throw new Error(result.data.message || 'プラン生成のリクエストに失敗しました。');
      }

    } catch (err) {
      console.error("Firebase Functionsの呼び出しに失敗しました:", err);
      setError(err.message);
      setStatus('error');
    }
  };

  const renderContent = () => {
    switch (status) {
      case 'loading':
        return (
          <View style={styles.statusContainer}>
            <ActivityIndicator size="large" color="#FF6347" />
            <Text style={styles.statusText}>AIがあなたに最適なプランを{'\n'}検索しています...</Text>
            {/* ▼▼▼【修正点】本番モードであることを明記 ▼▼▼ */}
            <Text style={styles.statusSubText}>（本番クラウド環境で実行中）</Text>
            {/* ▲▲▲【ここまで修正】▲▲▲ */}
          </View>
        );
      case 'success':
        return (
          <ScrollView>
            <Text style={styles.resultTitle}>
                {plans.length > 0 ? `プラン候補が ${plans.length}件見つかりました！` : 'プラン候補は見つかりませんでした'}
            </Text>
            {plans.map((plan, index) => (
              <TouchableOpacity key={index} style={styles.planCard} activeOpacity={0.7}>
                <Text style={styles.planTitle}>{plan.eventName}</Text>
                <Text style={styles.planSummary}>{plan.summary}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        );
      case 'error':
        return (
            <View style={styles.statusContainer}>
                <Ionicons name="alert-circle-outline" size={48} color="#D9534F" />
                <Text style={styles.errorText}>エラーが発生しました</Text>
                <Text style={styles.errorDetails}>{error}</Text>
                <Button title="再試行" onPress={handleSearchPlans} color="#FF6347" />
            </View>
        );
      case 'idle':
      default:
        return (
          <View style={styles.formContainer}>
            <Text style={styles.label}>お住まいの地域（市区町村まで）</Text>
            <TextInput
              style={styles.input}
              placeholder="例：神奈川県横浜市"
              value={location}
              onChangeText={setLocation}
            />
            <Text style={styles.label}>興味・関心</Text>
            <TextInput
              style={styles.input}
              placeholder="例：動物, 自然, 音楽"
              value={interests}
              onChangeText={setInterests}
            />
            <TouchableOpacity style={styles.searchButton} onPress={handleSearchPlans}>
              <Text style={styles.searchButtonText}>この条件でプランを探す</Text>
            </TouchableOpacity>
          </View>
        );
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={28} color="#333" />
        </TouchableOpacity>
        <Text style={styles.title}>お出かけプランニング</Text>
        <TouchableOpacity onPress={() => setStatus('idle')} style={styles.resetButton}>
            {status !== 'idle' && <Ionicons name="refresh" size={24} color="#333" />}
        </TouchableOpacity>
      </View>
      <View style={styles.content}>
        {renderContent()}
      </View>
    </SafeAreaView>
  );
};

// スタイルは変更なし
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F7F7F7' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 16, backgroundColor: 'white', borderBottomWidth: 1, borderBottomColor: '#EEE' },
  backButton: { padding: 4 },
  title: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  resetButton: { padding: 4, width: 28 },
  content: { flex: 1 },
  formContainer: { padding: 20 },
  label: { fontSize: 16, color: '#333', marginBottom: 8, marginTop: 16 },
  input: { backgroundColor: 'white', borderRadius: 10, padding: 14, fontSize: 16, borderWidth: 1, borderColor: '#DDD' },
  searchButton: { marginTop: 32, backgroundColor: '#FF6347', paddingVertical: 16, borderRadius: 12, alignItems: 'center', shadowColor: '#FF6347', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 5, elevation: 8 },
  searchButtonText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
  statusContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  statusText: { marginTop: 20, fontSize: 18, color: 'gray', textAlign: 'center', lineHeight: 25 },
  statusSubText: { marginTop: 8, fontSize: 14, color: '#A9A9A9' },
  resultTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 16, paddingHorizontal: 20, paddingTop: 20 },
  planCard: { backgroundColor: 'white', borderRadius: 12, padding: 16, marginHorizontal: 20, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4, elevation: 3 },
  planTitle: { fontSize: 16, fontWeight: 'bold', color: '#333', marginBottom: 4 },
  planSummary: { fontSize: 14, color: '#666' },
  errorText: { marginTop: 16, fontSize: 18, color: '#D9534F', fontWeight: 'bold' },
  errorDetails: { fontSize: 14, color: 'gray', marginTop: 8, marginBottom: 24, textAlign: 'center' },
});

export default PlanScreen;