import React, { useState, useEffect, useMemo } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    Alert,
    ScrollView,
    ActivityIndicator,
    Platform,
    Button,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getAuth, signInAnonymously } from 'firebase/auth';
import DateTimePicker from '@react-native-community/datetimepicker';

// ---- Cloud Functions Gen2 (onRequest) direct endpoints ----
// プロジェクト/リージョンに合わせて必要なら置き換えてください
const FUNCTIONS_BASE = 'https://asia-northeast1-aibabyapp-abeae.cloudfunctions.net';
const RUN_WEEKLY_PLANS_URL = `${FUNCTIONS_BASE}/runWeeklyPlansManually`;

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'Cache-Control': 'no-cache', ...(opts.headers || {}) } });
        return res;
    } finally {
        clearTimeout(id);
    }
}

/**
 * 週次プラン生成の呼び出し
 * 1) callable(generatePlansOnCall) をリージョン固定で試す
 * 2) 失敗したら onRequest (HTTP) へフォールバック
 */
async function callGeneratePlans(userId, payloadForCallable) {
    // 1) callable を試す（存在しない/リージョン違いなら例外→フォールバック）
    try {
        const functions = getFunctions(getApp(), 'asia-northeast1');
        const generatePlansOnCall = httpsCallable(functions, 'generatePlansOnCall');
        const res = await generatePlansOnCall(payloadForCallable);
        return { ok: true, via: 'callable', data: res?.data };
    } catch (e) {
        const diag = {
            where: 'httpsCallable(generatePlansOnCall)',
            code: e?.code || null,
            name: e?.name || null,
            message: e?.message || String(e),
            details: e?.details || null,
            stack: e?.stack ? String(e.stack).split('\n').slice(0, 3) : null,
        };
        console.warn('callable失敗→HTTP(onRequest)へフォールバック (diag):', diag);
    }

    // 2) onRequest (Functions v2, HTTP) を叩く（ユーザーIDのみで実行、サーバ側でFirestore参照）
    const qs = new URLSearchParams({ ui: 'json', userId }).toString();
    const url = `${RUN_WEEKLY_PLANS_URL}?${qs}`;
    console.log('[PlanScreen] onRequest fallback → GET', { url, userId, timeoutMs: 15000 });
    const resp = await fetchWithTimeout(url, { method: 'GET' }, 15000);
    if (!resp.ok) {
        let bodyText = '';
        try { bodyText = await resp.text(); } catch (_) { /* noop */ }
        const err = new Error(`Functions fetch failed: ${resp.status} ${resp.statusText || ''} ${bodyText ? ':: ' + bodyText.slice(0, 300) : ''}`);
        err.status = resp.status;
        err.statusText = resp.statusText;
        err.body = bodyText;
        throw err;
    }
    const json = await resp.json();
    return { ok: true, via: 'fetch', data: json };
}

// --- ヘルパー関数 ---
const formatDate = (date) => {
    if (!date) return '';
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
};

const PlanScreen = ({ navigation }) => {
    const functions = useMemo(() => getFunctions(getApp(), 'asia-northeast1'), []);
    const generatePlansProduction = useMemo(() => httpsCallable(functions, 'generatePlansOnCall'), [functions]);

    // --- State管理 ---
    const [location, setLocation] = useState('');
    const [interest1, setInterest1] = useState('');
    const [interest2, setInterest2] = useState('');
    const [interest3, setInterest3] = useState('');
    const [transportMode, setTransportMode] = useState('car');
    const [maxResults, setMaxResults] = useState('4');
    
    const defaultEndDate = new Date();
    defaultEndDate.setDate(defaultEndDate.getDate() + 30);
    const [startDate, setStartDate] = useState(new Date());
    const [endDate, setEndDate] = useState(defaultEndDate);

    const [showDatePicker, setShowDatePicker] = useState(false);
    const [datePickerFor, setDatePickerFor] = useState(null); // 'start' or 'end'

    const [status, setStatus] = useState('idle');
    const [error, setError] = useState(null);

    // --- データ読み込み ---
    useEffect(() => {
        const loadUserData = async () => {
            const savedLocation = await AsyncStorage.getItem('user_location');
            if (savedLocation) setLocation(savedLocation);
        };
        loadUserData();
    }, []);

    // --- イベントハンドラ ---
    const handleSearchPlans = async () => {
        if (!location.trim()) {
            Alert.alert('入力エラー', '住所を入力してください。');
            return;
        }
        
        const interests = [interest1, interest2, interest3].filter(i => i.trim() !== '');
        if (interests.length === 0) {
            Alert.alert('入力エラー', '興味・関心を1つ以上入力してください。');
            return;
        }

        setStatus('loading');
        setError(null);

        try {
            const auth = getAuth();
            let user = auth.currentUser;
            if (!user) {
                await signInAnonymously(auth);
                user = auth.currentUser;
            }
            if (!user) throw new Error('認証に失敗しました。');

            const payload = { 
                location, 
                interests,
                transportMode, 
                maxResults: parseInt(maxResults, 10) || 4, // 数値に変換
                dateRange: { 
                    start: startDate.toISOString().split('T')[0], // YYYY-MM-DD形式
                    end: endDate.toISOString().split('T')[0]      // YYYY-MM-DD形式
                }
            };

            const __t0 = Date.now();
            console.log('[PlanScreen] プラン生成をリクエスト', {
                uid: user.uid,
                region: 'asia-northeast1',
                via: 'callable→fallback(onRequest)',
                payload,
            });

            // ▼▼▼ callable優先＋Cloud Runフォールバック ▼▼▼
            const result = await callGeneratePlans(user.uid, payload);
            console.log('[PlanScreen] generatePlans trigger duration(ms):', Date.now() - __t0);
            console.log('[PlanScreen] trigger result', { via: result.via, status: result?.data?.status, data: result.data });

            if (result.via === 'callable') {
                const st = result?.data?.status;
                console.log('[PlanScreen] callable returned status:', st);
                if (st === 'completed') {
                    Alert.alert(
                        '作成完了',
                        '提案プランを保存しました。画面を閉じて「提案」タブをご確認ください。',
                        [{ text: '提案を見る', onPress: () => navigation.navigate('SuggestedPlans') }]
                    );
                    setStatus('idle');
                } else if (st === 'processing_started') {
                    Alert.alert(
                        '受付完了',
                        'プランの生成を開始しました。完了次第、ホーム画面でお知らせします。',
                        [{ text: 'ホームに戻る', onPress: () => navigation.goBack() }]
                    );
                    setStatus('idle');
                } else {
                    console.warn('[PlanScreen] callable unexpected status:', st, result?.data);
                    throw new Error(result?.data?.message || 'プラン生成のリクエストに失敗しました。');
                }
            } else {
                // Cloud Run（onRequest）経由の場合、同期完了(200/completed)か、受付(202)のどちらもあり得る
                const st = result?.data?.status;
                console.log('[PlanScreen] onRequest returned status:', st);
                if (st === 'completed') {
                    Alert.alert(
                        '作成完了',
                        '提案プランを保存しました。画面を閉じて「提案」タブをご確認ください。',
                        [{ text: '提案を見る', onPress: () => navigation.navigate('SuggestedPlans') }]
                    );
                } else {
                    Alert.alert(
                        '受付完了',
                        'プランの作成を開始しました。完了すると「提案」に表示されます。',
                        [{ text: 'ホームに戻る', onPress: () => navigation.goBack() }]
                    );
                }
                setStatus('idle');
            }

        } catch (err) {
            console.error("Firebase Functionsの呼び出しに失敗しました:", err);
            const msg = `${err.name || 'Error'}${err.code ? ` (${err.code})` : ''}: ${err.message || String(err)}`;
            setError(msg);
            console.log('[PlanScreen] handleSearchPlans error detail:', err);
            console.log('[PlanScreen] normalized error diag:', {
                name: err?.name || null,
                code: err?.code || null,
                message: err?.message || String(err),
                status: err?.status || null,
                statusText: err?.statusText || null,
                body: err?.body ? String(err.body).slice(0, 300) : null,
            });
            setStatus('error');
        }
    };

    const onDateChange = (event, selectedDate) => {
        setShowDatePicker(Platform.OS === 'ios');
        if (selectedDate) {
            if (datePickerFor === 'start') {
                setStartDate(selectedDate);
                if (selectedDate > endDate) {
                    setEndDate(selectedDate); // 開始日が終了日を追い越さないように
                }
            } else {
                setEndDate(selectedDate);
            }
        }
    };

    const openDatePicker = (target) => {
        setDatePickerFor(target);
        setShowDatePicker(true);
    };

    // --- レンダリング ---
    if (status === 'loading') {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.statusContainer}>
                    <ActivityIndicator size="large" color="#FF6347" />
                    <Text style={styles.statusText}>AIがあなたに最適なプランを{'\n'}検索しています...</Text>
                </View>
            </SafeAreaView>
        );
    }
    
    if (status === 'error') {
        return (
             <SafeAreaView style={styles.container}>
                <View style={styles.statusContainer}>
                    <Ionicons name="alert-circle-outline" size={48} color="#D9534F" />
                    <Text style={styles.errorText}>エラーが発生しました</Text>
                    <Text style={styles.errorDetails}>{error}</Text>
                    <Button title="再試行" onPress={handleSearchPlans} color="#FF6347" />
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
                    <Ionicons name="chevron-back" size={28} color="#333" />
                </TouchableOpacity>
                <Text style={styles.title}>お出かけプランニング</Text>
                <View style={{width: 28}}/>
            </View>
            <ScrollView style={styles.formContainer}>
                <Text style={styles.label}>住所</Text>
                <TextInput style={styles.input} placeholder="例：神奈川県横浜市" value={location} onChangeText={setLocation} placeholderTextColor="#AAAAAA" />

                <Text style={styles.label}>興味・関心 (最大3つ)</Text>
                <TextInput style={styles.input} placeholder="キーワード1 (例: 恐竜)" value={interest1} onChangeText={setInterest1} placeholderTextColor="#AAAAAA" />
                <TextInput style={[styles.input, {marginTop: 8}]} placeholder="キーワード2 (例: 公園)" value={interest2} onChangeText={setInterest2} placeholderTextColor="#AAAAAA" />
                <TextInput style={[styles.input, {marginTop: 8}]} placeholder="キーワード3 (例: トミカ)" value={interest3} onChangeText={setInterest3} placeholderTextColor="#AAAAAA" />
                
                <Text style={styles.label}>移動手段</Text>
                <View style={styles.segmentedControl}>
                    <TouchableOpacity style={[styles.segmentButton, transportMode === 'car' && styles.segmentButtonActive]} onPress={() => setTransportMode('car')}>
                        <Text style={[styles.segmentButtonText, transportMode === 'car' && styles.segmentButtonTextActive]}>車</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.segmentButton, transportMode === 'public' && styles.segmentButtonActive]} onPress={() => setTransportMode('public')}>
                        <Text style={[styles.segmentButtonText, transportMode === 'public' && styles.segmentButtonTextActive]}>公共交通機関</Text>
                    </TouchableOpacity>
                </View>

                <Text style={styles.label}>期間</Text>
                <View style={styles.dateRangeContainer}>
                    <TouchableOpacity style={styles.dateInput} onPress={() => openDatePicker('start')}>
                        <Text>{formatDate(startDate)}</Text>
                    </TouchableOpacity>
                    <Text style={{marginHorizontal: 10}}>〜</Text>
                    <TouchableOpacity style={styles.dateInput} onPress={() => openDatePicker('end')}>
                        <Text>{formatDate(endDate)}</Text>
                    </TouchableOpacity>
                </View>

                <Text style={styles.label}>最大提案数</Text>
                <TextInput style={styles.input} value={maxResults} onChangeText={setMaxResults} keyboardType="numeric" placeholderTextColor="#AAAAAA" />

                <TouchableOpacity style={styles.searchButton} onPress={handleSearchPlans}>
                    <Text style={styles.searchButtonText}>この条件でプランを探す</Text>
                </TouchableOpacity>
            </ScrollView>

            {showDatePicker && (
                <DateTimePicker
                    value={datePickerFor === 'start' ? startDate : endDate}
                    mode="date"
                    display="spinner"
                    onChange={onDateChange}
                    minimumDate={datePickerFor === 'end' ? startDate : new Date()} // 終了日は開始日より前に設定不可
                />
            )}
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F7F7F7' },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 16, backgroundColor: 'white', borderBottomWidth: 1, borderBottomColor: '#EEE' },
    backButton: { padding: 4 },
    title: { fontSize: 20, fontWeight: 'bold', color: '#333' },
    formContainer: { padding: 20 },
    label: { fontSize: 16, color: '#333', marginBottom: 8, marginTop: 16, fontWeight: '600' },
    input: { backgroundColor: 'white', borderRadius: 10, padding: 14, fontSize: 16, borderWidth: 1, borderColor: '#DDD' },
    searchButton: { marginTop: 32, marginBottom: 60, backgroundColor: '#FF6347', paddingVertical: 16, borderRadius: 12, alignItems: 'center', shadowColor: '#FF6347', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 5, elevation: 8 },
    searchButtonText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
    statusContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
    statusText: { marginTop: 20, fontSize: 18, color: 'gray', textAlign: 'center', lineHeight: 25 },
    errorText: { marginTop: 16, fontSize: 18, color: '#D9534F', fontWeight: 'bold' },
    errorDetails: { fontSize: 14, color: 'gray', marginTop: 8, marginBottom: 24, textAlign: 'center' },
    segmentedControl: { flexDirection: 'row', backgroundColor: '#EFEFEF', borderRadius: 10, overflow: 'hidden' },
    segmentButton: { flex: 1, padding: 12, alignItems: 'center' },
    segmentButtonActive: { backgroundColor: '#FF6347' },
    segmentButtonText: { color: '#333', fontWeight: '600' },
    segmentButtonTextActive: { color: 'white' },
    dateRangeContainer: { flexDirection: 'row', alignItems: 'center' },
    dateInput: { flex: 1, backgroundColor: 'white', borderRadius: 10, padding: 14, fontSize: 16, borderWidth: 1, borderColor: '#DDD', alignItems: 'center' },
});

export default PlanScreen;
