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

            console.log(`プラン生成をリクエスト:`, payload);

            // ▼▼▼【修正点】コメントアウトを解除し、新しいpayloadを送信 ▼▼▼
            const result = await generatePlansProduction(payload);

            if (result.data.status === 'processing_started') {
                Alert.alert(
                    '受付完了',
                    'プランの生成を開始しました。完了次第、ホーム画面でお知らせします。',
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
