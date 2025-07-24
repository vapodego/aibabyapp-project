// This is a dummy comment to force re-bundling. (2025-07-23 13:58 JST)
import { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TextInput,
    Button,
    FlatList,
    Alert,
    Platform,
    TouchableOpacity,
    Dimensions,
    SafeAreaView,
    ScrollView,
    Modal,
    InteractionManager,
    ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useFocusEffect } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system';

const screenWidth = Dimensions.get('window').width;

const ICONS = {
    ミルク: '🍼', うんち: '💩', おしっこ: '💧', 寝る: '😴', 起きる: '☀️', 離乳食: '🍚',
    体温: '🌡️', 入浴: '🛁', その他: '➕',
};

// --- Helper Functions (from original) ---
const getFormattedDate = (dateTime) => {
    if (!dateTime) return '';
    const date = new Date(dateTime);
    if (isNaN(date)) return '';
    return date.toISOString().split('T')[0];
};

const getHourFromDateTimeString = (dateTimeString) => {
    if (!dateTimeString) return -1;
    const date = new Date(dateTimeString);
    if (isNaN(date)) return -1;
    return date.getHours();
};

const getMinuteFromDateTimeString = (dateTimeString) => {
    if (!dateTimeString) return -1;
    const date = new Date(dateTimeString);
    if (isNaN(date)) return -1;
    return date.getMinutes();
};


const getDailySummary = (records, dateString) => {
    const dailyRecords = records
        .filter(r => getFormattedDate(r.time) === dateString)
        .sort((a, b) => new Date(a.time) - new Date(b.time));

    let milkAmount = 0;
    let poopCount = 0;
    let sleepDuration = 0;
    let lastSleepTime = null;

    dailyRecords.forEach(record => {
        if (record.type === 'ミルク' && record.data?.amount) {
            milkAmount += Number(record.data.amount) || 0;
        } else if (record.type === 'うんち') {
            poopCount += 1;
        } else if (record.type === '寝る') {
            lastSleepTime = new Date(record.time);
        } else if (record.type === '起きる' && lastSleepTime) {
            const wakeUpTime = new Date(record.time);
            const duration = (wakeUpTime - lastSleepTime) / (1000 * 60); // 分単位
            if (duration > 0) {
                sleepDuration += duration;
            }
            lastSleepTime = null;
        }
    });
    return { milk: milkAmount, poop: poopCount, sleep: Math.round(sleepDuration) };
};

const getPast7DayAverage = (allRecords, currentDisplayDate) => {
    const summaries = [];
    for (let i = 1; i <= 7; i++) {
        const pastDate = new Date(currentDisplayDate);
        pastDate.setDate(currentDisplayDate.getDate() - i);
        const formattedPastDate = getFormattedDate(pastDate);
        summaries.push(getDailySummary(allRecords, formattedPastDate));
    }

    const totalMilk = summaries.reduce((sum, s) => sum + s.milk, 0);
    const totalPoop = summaries.reduce((sum, s) => sum + s.poop, 0);
    const totalSleep = summaries.reduce((sum, s) => sum + s.sleep, 0);

    return {
        milk: Math.round(totalMilk / 7) || 0,
        poop: Math.round(totalPoop / 7) || 0,
        sleep: Math.round(totalSleep / 7) || 0,
    };
};

// --- Components (from original) ---
const RecordInputForm = ({ onSave, onClose, recordType }) => {
    return (
        <View style={[styles.modalContent, { alignSelf: 'stretch' }]}>
            <Text style={styles.modalTitle}>📋 {recordType}の記録</Text>
            <Text>（入力フォームはここに表示されます）</Text>
            <Button title="記録する" onPress={onSave} />
            <View style={{ marginTop: 10 }}><Button title="キャンセル" onPress={onClose} color="#888" /></View>
        </View>
    );
};

const DebugButtons = ({ clearAllRecords }) => {
    return (
        <View style={styles.debugButtonsContainer}>
            <Button title="🛠 全削除" onPress={clearAllRecords} color="red" />
        </View>
    );
};


// --- Main Component ---
export default function RecordScreen({ navigation }) {
    // --- State ---
    const [records, setRecords] = useState([]);
    const [currentDisplayDate, setCurrentDisplayDate] = useState(new Date());
    const [currentTime, setCurrentTime] = useState(new Date());
    const [appReady, setAppReady] = useState(false);
    const [name, setName] = useState('陽翔');
    const [age, setAge] = useState('4ヶ月10日');
    const [showRecordModal, setShowRecordModal] = useState(false);
    const [modalRecordType, setModalRecordType] = useState('ミルク');

    // Voice related state
    const [recording, setRecording] = useState(null);
    const [isProcessingVoice, setIsProcessingVoice] = useState(false);
    const [recognizedText, setRecognizedText] = useState('');
    const [parsedRecord, setParsedRecord] = useState(null);
    const [showConfirmModal, setShowConfirmModal] = useState(false);
    const ws = useRef(null);

    const today = getFormattedDate(currentDisplayDate);
    const isToday = getFormattedDate(new Date()) === today;

    // --- Data Handling ---
    const loadRecords = useCallback(async () => {
        try {
            const rawData = await AsyncStorage.getItem('records');
            const recordsToLoad = rawData ? JSON.parse(rawData) : [];
            const cleaned = recordsToLoad.filter(item => item && item.id && item.time)
                .map(item => (!item.data ? { ...item, data: { ...item } } : item));
            // ★★★ 変更点: ここでのソートは不要なので削除 ★★★
            // cleaned.sort((a, b) => new Date(b.time) - new Date(a.time));
            setRecords(cleaned);
        } catch (err) {
            Alert.alert('エラー', 'データの読み込みに失敗しました。');
        }
    }, []);

    const saveNewRecord = async (recordToSave) => {
        try {
            const existing = await AsyncStorage.getItem('records');
            const updated = [...(existing ? JSON.parse(existing) : []), recordToSave];
            await AsyncStorage.setItem('records', JSON.stringify(updated));
            await loadRecords();
            // ★★★ 変更点: 成功時のアラートをコメントアウト ★★★
            // Alert.alert('成功', `${recordToSave.type}の記録を保存しました`);
        } catch (e) {
            Alert.alert('失敗', '記録の保存に失敗しました');
        }
    };

    const clearAllRecords = () => {
        Alert.alert(
            '確認',
            'すべての記録を本当に削除しますか？',
            [
                { text: 'キャンセル', style: 'cancel' },
                {
                    text: '削除',
                    onPress: async () => {
                        try {
                            await AsyncStorage.removeItem('records');
                            setRecords([]);
                            Alert.alert('成功', 'すべての記録を削除しました。');
                        } catch (e) {
                            Alert.alert('失敗', '記録の削除に失敗しました。');
                        }
                    },
                    style: 'destructive',
                },
            ]
        );
    };
    
    // --- Voice Handling ---
    const startRecording = async () => {
        try {
            await Audio.requestPermissionsAsync();
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: true,
                playsInSilentModeIOS: true,
            }); 
            
            const newRecording = new Audio.Recording();
            await newRecording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
            await newRecording.startAsync();

            setRecording(newRecording);
            console.log('🎙️ 録音開始 (expo-av)');
        } catch (err) {
            console.error('録音開始に失敗:', err);
        }
    };

    const stopRecording = async () => {
        if (!recording) return;
        console.log('⏹️ 録音停止中...');
        try {
            await recording.stopAndUnloadAsync();
            const uri = recording.getURI();
            console.log('録音URI:', uri);
            setRecording(null);
            if (uri) {
                connectWebSocketAndSend(uri);
            }
        } catch (error) {
            console.error('録音停止に失敗:', error);
        }
    };

    const connectWebSocketAndSend = (uri) => {
        const wsUrl = 'ws://10.0.2.2:8090'; 
        ws.current = new WebSocket(wsUrl);
        setIsProcessingVoice(true);
        setRecognizedText('');

        ws.current.onopen = async () => {
            console.log('WebSocket 接続成功');
            try {
                const base64Audio = await FileSystem.readAsStringAsync(uri, {
                    encoding: FileSystem.EncodingType.Base64,
                });
                
                console.log("� 音声データをBase64で送信中...");
                ws.current.send(JSON.stringify({ audio: base64Audio }));

            } catch (error) {
                console.error("送信エラー:", error);
                Alert.alert("送信エラー", "音声ファイルの読み込みまたは送信に失敗しました。");
                setIsProcessingVoice(false);
                if (ws.current) ws.current.close();
            }
        };

        ws.current.onmessage = (e) => {
            try {
                const message = JSON.parse(e.data);
                if (message.text) {
                    console.log("📝 サーバーからの文字起こし:", message.text);
                    setRecognizedText(message.text); 
                    parseTextWithLLM(message.text);
                } else if (message.error) {
                    Alert.alert("音声認識エラー", message.error);
                }
            } catch (error) {
                console.log("サーバーからのメッセージ(非JSON):", e.data);
            }
            if (ws.current) ws.current.close();
        };

        ws.current.onerror = (e) => {
            console.error("WebSocket エラー", e.message);
            Alert.alert("通信エラー", `サーバー(${wsUrl})との接続に失敗しました。`);
            setIsProcessingVoice(false);
        };
        
        ws.current.onclose = () => {
            console.log("WebSocket 接続が閉じられました。");
        };
    };
    
    const parseTextWithLLM = async (text) => {
        console.log("LLMに解析を依頼:", text);
        const currentDate = new Date().toISOString();
        const prompt = `
            以下のユーザー発話から育児記録の情報を抽出し、JSON形式で出力してください。
            現在の時刻は「${currentDate}」です。これを基準に時間を解釈してください。
            もし発話に時刻の指定がなければ、必ずこの現在時刻を使用してください。
            時間は「YYYY-MM-DDTHH:mm:ss.sssZ」のISO 8601形式で出力してください。
            記録の種類(type)は「ミルク」「うんち」「おしっこ」「寝る」「起きる」「離乳食」「体温」「入浴」「その他」のいずれかです。
            
            # 発話内容:
            "${text}"

            # 出力形式 (JSON):
            {
              "type": "記録の種類",
              "time": "解釈したISO 8601形式の時間",
              "data": {
                "amount": "量(mlやgなど)",
                "note": "メモ"
              }
            }
        `;
        try {
            const res = await fetch('https://api.moonshot.ai/v1/chat/completions', {
                method: 'POST',
                headers: { 
                    'Authorization': 'Bearer sk-aQ25cqdGil3eIOmyRt6l4VJiOHwcmx1is1oC4gi8gc6ydFNh', // TODO: Add your API Key
                    'Content-Type': 'application/json', 
                },
                body: JSON.stringify({ model: 'moonshot-v1-8k', messages: [{ role: 'system', content: prompt }], temperature: 0.3, }),
            });

            if (!res.ok) {
                const errorBody = await res.text();
                throw new Error(`APIリクエスト失敗: ${res.status} ${errorBody}`);
            }

            const json = await res.json();

            if (json && json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
                const content = json.choices[0].message.content;
                console.log("LLMからの解析結果:", content);
                
                const jsonString = content.match(/\{.*\}/s);
                if (!jsonString) {
                    throw new Error("LLMから有効なJSONが返されませんでした。");
                }
                const parsedJson = JSON.parse(jsonString[0]);
                setParsedRecord({ id: Date.now().toString(), ...parsedJson });
                setShowConfirmModal(true);
            } else {
                throw new Error("LLMから予期しない形式の応答がありました。");
            }

        } catch (e) {
            console.error('LLM解析エラー:', e);
            Alert.alert('解析失敗', 'すみません、うまく聞き取れませんでした。もう一度試してみてください。');
        } finally {
            setIsProcessingVoice(false);
        }
    };

    const handleConfirmSave = () => {
        if (parsedRecord) saveNewRecord(parsedRecord);
        setShowConfirmModal(false);
        setParsedRecord(null);
        setRecognizedText('');
    };

    const handleCancelSave = () => {
        setShowConfirmModal(false);
        setParsedRecord(null);
        setRecognizedText('');
    };

    const openRecordModal = (type) => {
        setModalRecordType(type);
        setShowRecordModal(true);
    };

    // --- Effects ---
    useEffect(() => {
        const intervalId = setInterval(() => setCurrentTime(new Date()), 60000);
        return () => clearInterval(intervalId);
    }, []);

    useFocusEffect(useCallback(() => {
        InteractionManager.runAfterInteractions(() => {
            loadRecords().then(() => setAppReady(true));
        });
    }, [loadRecords]));

    // --- Render ---
    if (!appReady) {
        return <View style={styles.container}><ActivityIndicator size="large" /></View>;
    }

    const todayRecords = records.filter(r => getFormattedDate(r.time) === today);
    const todaySummary = getDailySummary(records, today);
    const average7DayAverage = getPast7DayAverage(records, currentDisplayDate);
    const maxMilk = Math.max(todaySummary.milk, average7DayAverage.milk, 1);
    const maxPoop = Math.max(todaySummary.poop, average7DayAverage.poop, 1);
    const maxSleep = Math.max(todaySummary.sleep, average7DayAverage.sleep, 1);

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.headerRow}>
                <View style={styles.headerLeftGroup}>
                    <TouchableOpacity onPress={() => navigation.navigate('Chat')}><Text style={styles.homeLink}>🏠 ホームへ</Text></TouchableOpacity>
                    <Text style={styles.childNameTextHeader}>{name}</Text>
                    <Text style={styles.childAgeTextHeader}>（{age}）</Text>
                </View>
                <DebugButtons clearAllRecords={clearAllRecords} />
            </View>

            {recognizedText ? (
                <View style={styles.recognizedTextView}>
                    <Text style={styles.recognizedTextLabel}>📝 認識されたテキスト:</Text>
                    <Text style={styles.recognizedTextContent}>{recognizedText}</Text>
                </View>
            ) : null}

            <View style={styles.dateNavigation}>
                <TouchableOpacity onPress={() => setCurrentDisplayDate(d => new Date(d.setDate(d.getDate() - 1)))} style={styles.dateNavButton}><Text style={styles.dateNavButtonText}>◀️ 前日</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => {}}><Text style={styles.date}>{today}{isToday ? ' (今日)' : ''}</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => setCurrentDisplayDate(d => new Date(d.setDate(d.getDate() + 1)))} style={styles.dateNavButton}><Text style={styles.dateNavButtonText}>翌日 ▶️</Text></TouchableOpacity>
            </View>

            <ScrollView style={styles.mainContentScrollView}>
                <View style={styles.timelineContainer}>
                    {todayRecords.length === 0 ? (
                        <Text style={styles.empty}>📌 今日の記録はまだありません</Text>
                    ) : (
                        <FlatList
                            data={Array.from({ length: 24 }, (_, i) => i)}
                            keyExtractor={(hour) => hour.toString()}
                            renderItem={({ item: hour }) => {
                                // ★★★ 変更点: 時間内の記録を昇順（古い順）にソート ★★★
                                const recordsInThisHour = todayRecords
                                    .filter(r => getHourFromDateTimeString(r.time) === hour)
                                    .sort((a, b) => new Date(a.time) - new Date(b.time));
                                
                                return (
                                    <View style={styles.hourSlot}>
                                        <Text style={styles.hourLabel}>{hour.toString().padStart(2, '0')}</Text>
                                        <View style={styles.recordsInHourContainer}>
                                            {recordsInThisHour.map(record => (
                                                <View key={record.id} style={styles.timelineRecordItem}>
                                                    <Text style={styles.timelineRecordMinute}>{String(getMinuteFromDateTimeString(record.time) || '00').padStart(2, '0')}</Text>
                                                    <View style={styles.timelineRecordContentWrapper}>
                                                        <Text style={styles.timelineRecordContent}>
                                                            {`${ICONS[record.type] ?? '📘'} ${record.type}`}
                                                            {record.data.amount ? ` 📦 ${record.data.amount}` : ''}
                                                            {record.data.note ? ` 📝 ${record.data.note}` : ''}
                                                        </Text>
                                                    </View>
                                                </View>
                                            ))}
                                            {hour === currentTime.getHours() && isToday && (
                                                <View style={[styles.currentTimeLine, { top: `${(currentTime.getMinutes() / 60) * 100}%` }]} />
                                            )}
                                        </View>
                                    </View>
                                );
                            }}
                            scrollEnabled={false}
                        />
                    )}
                </View>

                <View style={styles.statsContainer}>
                    <Text style={styles.statsTitle}>📊 統計情報</Text>
                    <View style={styles.statsContentRow}>
                        <View style={styles.statColumn}><View style={styles.verticalBarsWrapper}><View style={[styles.verticalBar, styles.barAverage, { height: `${(average7DayAverage.milk / maxMilk) * 90}%` }]} /><View style={[styles.verticalBar, styles.barToday, { height: `${(todaySummary.milk / maxMilk) * 90}%` }]} /></View><Text style={styles.barValueSmall}>{ICONS['ミルク']} {todaySummary.milk}ml</Text><Text style={styles.barValueSmall}>Avg: {average7DayAverage.milk}ml</Text></View>
                        <View style={styles.statColumn}><View style={styles.verticalBarsWrapper}><View style={[styles.verticalBar, styles.barAverage, { height: `${(average7DayAverage.poop / maxPoop) * 90}%` }]} /><View style={[styles.verticalBar, styles.barToday, { height: `${(todaySummary.poop / maxPoop) * 90}%` }]} /></View><Text style={styles.barValueSmall}>{ICONS['うんち']} {todaySummary.poop}回</Text><Text style={styles.barValueSmall}>Avg: {average7DayAverage.poop}回</Text></View>
                        <View style={styles.statColumn}><View style={styles.verticalBarsWrapper}><View style={[styles.verticalBar, styles.barAverage, { height: `${(average7DayAverage.sleep / maxSleep) * 90}%` }]} /><View style={[styles.verticalBar, styles.barToday, { height: `${(todaySummary.sleep / maxSleep) * 90}%` }]} /></View><Text style={styles.barValueSmall}>{ICONS['寝る']} {Math.floor(todaySummary.sleep / 60)}h{todaySummary.sleep % 60}m</Text><Text style={styles.barValueSmall}>Avg: {Math.floor(average7DayAverage.sleep / 60)}h{average7DayAverage.sleep % 60}m</Text></View>
                    </View>
                </View>
            </ScrollView>

            <View style={styles.bottomBar}>
                {Object.entries(ICONS).map(([type, icon]) => (
                    <TouchableOpacity key={type} style={styles.iconButton} onPress={() => openRecordModal(type)}>
                        <Text style={styles.iconText}>{icon}</Text><Text style={styles.iconLabel}>{type}</Text>
                    </TouchableOpacity>
                ))}
            </View>
            
            <Modal animationType="slide" transparent={true} visible={showRecordModal} onRequestClose={() => setShowRecordModal(false)}>
                <View style={styles.centeredView}><RecordInputForm recordType={modalRecordType} onSave={() => {}} onClose={() => setShowRecordModal(false)} /></View>
            </Modal>
            
            {isProcessingVoice && (
                <View style={styles.processingOverlay}>
                    <ActivityIndicator size="large" color="#fff" />
                    <Text style={styles.processingText}>音声解析中...</Text>
                    {recognizedText && <Text style={styles.recognizedTextPreview}>「{recognizedText}」</Text>}
                </View>
            )}

            <TouchableOpacity style={styles.micButton} onPress={recording ? stopRecording : startRecording} activeOpacity={0.8}>
                <Ionicons name={recording ? 'stop-circle' : 'mic-circle'} size={64} color="white" />
            </TouchableOpacity>

            <Modal animationType="slide" transparent={true} visible={showConfirmModal} onRequestClose={handleCancelSave}>
                <View style={styles.centeredView}>
                    <View style={styles.modalView}>
                        <Text style={styles.modalTitle}>以下の内容で記録しますか？</Text>
                        {parsedRecord && (
                            <View style={styles.confirmDetails}>
                                <Text style={styles.confirmText}>種類: {ICONS[parsedRecord.type] || '❓'} {parsedRecord.type}</Text>
                                <Text style={styles.confirmText}>時間: {new Date(parsedRecord.time).toLocaleString('ja-JP')}</Text>
                                {parsedRecord.data?.amount && <Text style={styles.confirmText}>量: {parsedRecord.data.amount}</Text>}
                                {parsedRecord.data?.note && <Text style={styles.confirmText}>メモ: {parsedRecord.data.note}</Text>}
                            </View>
                        )}
                        <View style={styles.modalButtons}>
                            <Button title="キャンセル" onPress={handleCancelSave} color="#888" />
                            <Button title="保存する" onPress={handleConfirmSave} />
                        </View>
                    </View>
                </View>
            </Modal>

        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#FFF8F0' },
    headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 10, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: '#eee' },
    headerLeftGroup: { flexDirection: 'row', alignItems: 'center' },
    homeLink: { fontSize: 12, color: '#007AFF', marginRight: 8 },
    childNameTextHeader: { fontSize: 16, fontWeight: 'bold', color: '#333' },
    childAgeTextHeader: { fontSize: 14, color: '#555', marginLeft: 4 },
    debugButtonsContainer: { flexDirection: 'row' },
    recognizedTextView: {
        backgroundColor: '#e6f7ff',
        padding: 10,
        marginHorizontal: 14,
        borderRadius: 8,
        marginTop: 5,
    },
    recognizedTextLabel: {
        fontSize: 12,
        color: '#007AFF',
        fontWeight: 'bold',
        marginBottom: 4,
    },
    recognizedTextContent: {
        fontSize: 16,
        color: '#333',
    },
    dateNavigation: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, marginVertical: 12, backgroundColor: '#f0f0f0', paddingVertical: 8, borderRadius: 8, marginHorizontal: 14 },
    dateNavButton: { paddingVertical: 4, paddingHorizontal: 8, backgroundColor: '#e0e0e0', borderRadius: 5 },
    dateNavButtonText: { fontSize: 12, color: '#555', fontWeight: 'bold' },
    date: { fontSize: 14, alignSelf: 'center', color: '#555', fontWeight: 'bold' },
    mainContentScrollView: { flex: 1, marginBottom: 60 },
    statsContainer: { backgroundColor: '#fff', marginHorizontal: 20, padding: 8, borderRadius: 10, marginTop: 15, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 2 },
    statsTitle: { fontSize: 14, fontWeight: 'bold', marginBottom: 6, color: '#333', borderBottomWidth: 1, borderColor: '#eee', paddingBottom: 3 },
    statsContentRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-end' },
    statColumn: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 1 },
    verticalBarsWrapper: { flexDirection: 'row', height: 30, alignItems: 'flex-end', marginBottom: 3, width: 30, justifyContent: 'space-between' },
    verticalBar: { width: 12, borderRadius: 2 },
    barToday: { backgroundColor: '#4CAF50' },
    barAverage: { backgroundColor: '#8BC34A' },
    barValueSmall: { fontSize: 9, textAlign: 'center', color: '#333' },
    timelineContainer: { paddingHorizontal: 14, paddingBottom: 8, backgroundColor: '#f8f8f8' },
    hourSlot: { flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 1, borderColor: '#eee', paddingVertical: 4, backgroundColor: '#fff', position: 'relative' },
    hourLabel: { fontSize: 14, fontWeight: 'bold', color: '#333', width: 35, textAlign: 'right', paddingRight: 8 },
    recordsInHourContainer: { flex: 1, paddingLeft: 8, borderLeftWidth: 1, borderColor: '#ddd' },
    timelineRecordItem: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#e6f7ff', borderRadius: 4, padding: 6, marginBottom: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.03, shadowRadius: 1, elevation: 1 },
    timelineRecordMinute: { fontSize: 12, fontWeight: 'bold', color: '#007AFF', width: 25, textAlign: 'right', paddingRight: 4 },
    timelineRecordContentWrapper: { flex: 1, marginLeft: 4 },
    timelineRecordContent: { fontSize: 12, color: '#333' },
    empty: { color: '#777', fontSize: 12, marginTop: 8, textAlign: 'center', paddingBottom: 15 },
    bottomBar: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderColor: '#ccc', backgroundColor: '#fff', height: 60, position: 'absolute', bottom: 0, left: 0, right: 0 },
    iconButton: { alignItems: 'center', padding: 4 },
    iconText: { fontSize: 24, marginBottom: 1 },
    iconLabel: { fontSize: 10, color: '#555' },
    centeredView: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
    modalView: { margin: 16, backgroundColor: 'white', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 16, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, shadowRadius: 3, elevation: 4, width: '90%', maxHeight: '75%' },
    modalContent: { width: '100%', alignItems: 'center' },
    modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 16, color: '#333' },
    currentTimeLine: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: 'red', zIndex: 1 },
    micButton: { position: 'absolute', bottom: 80, right: 20, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 32, padding: 6, zIndex: 100 },
    processingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center' },
    processingText: { color: '#fff', marginTop: 10, fontSize: 16 },
    recognizedTextPreview: { color: '#fff', marginTop: 20, paddingHorizontal: 20, fontSize: 18, fontStyle: 'italic' },
    confirmDetails: { marginBottom: 20, alignItems: 'flex-start' },
    confirmText: { fontSize: 16, marginBottom: 5 },
    modalButtons: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
});
