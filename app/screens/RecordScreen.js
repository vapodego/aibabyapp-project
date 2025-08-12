// This is a dummy comment to force re-bundling. (2025-07-23 14:20 JST)
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
    ScrollView,
    Modal,
    InteractionManager,
    ActivityIndicator,
    Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useFocusEffect } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system';
import { GEMINI_API_KEY } from '@env';



const screenWidth = Dimensions.get('window').width;

const ICONS = {
    ミルク: '🍼', うんち: '💩', おしっこ: '💧', 寝る: '😴', 起きる: '☀️', 離乳食: '🍚',
    体温: '🌡️', 身長: '📏', 体重: '⚖️', 入浴: '🛁', その他: '➕',
};

// --- Helper ---
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

    let milkAmount = 0, poopCount = 0, sleepDuration = 0, lastSleepTime = null;

    dailyRecords.forEach(record => {
        if (record.type === 'ミルク' && record.data?.amount) {
            milkAmount += Number(record.data.amount) || 0;
        } else if (record.type === 'うんち') {
            poopCount += 1;
        } else if (record.type === '寝る') {
            lastSleepTime = new Date(record.time);
        } else if (record.type === '起きる' && lastSleepTime) {
            const wakeUpTime = new Date(record.time);
            const duration = (wakeUpTime - lastSleepTime) / (1000 * 60);
            if (duration > 0) sleepDuration += duration;
            lastSleepTime = null;
        }
    });
    return { milk: Math.round(milkAmount), poop: poopCount, sleep: Math.round(sleepDuration) };
};
const getPast7DayAverage = (allRecords, currentDisplayDate) => {
    const summaries = [];
    for (let i = 1; i <= 7; i++) {
        const pastDate = new Date(currentDisplayDate);
        pastDate.setDate(currentDisplayDate.getDate() - i);
        const formattedPastDate = getFormattedDate(pastDate);
        summaries.push(getDailySummary(allRecords, formattedPastDate));
    }
    const totalMilk = summaries.reduce((s, x) => s + x.milk, 0);
    const totalPoop = summaries.reduce((s, x) => s + x.poop, 0);
    const totalSleep = summaries.reduce((s, x) => s + x.sleep, 0);
    return {
        milk: Math.round(totalMilk / 7) || 0,
        poop: Math.round(totalPoop / 7) || 0,
        sleep: Math.round(totalSleep / 7) || 0,
    };
};

// ★★★ 入力フォーム（“選ぶだけ”UI & 背景は白でくっきり） ★★★
const RecordInputForm = ({
    recordType, amount, setAmount, note, setNote,
    poopConsistency, setPoopConsistency,
    menu, setMenu, temp, setTemp,
    height, setHeight, weight, setWeight,
    onSave, onClose
}) => {
    const renderInputFields = () => {
        switch (recordType) {
            case 'ミルク': {
  return (
    <>
      <TextInput placeholder="量（ml）" value={amount} onChangeText={setAmount} keyboardType="numeric" style={styles.input} />
      <TextInput placeholder="メモ" value={note} onChangeText={setNote} style={styles.input} />
    </>
 );
            }
            case 'うんち':
                return (
                    <>
                        <Text style={styles.pickerLabel}>硬さ</Text>
                        <View style={styles.wheelRow}>
                            <Picker
                                selectedValue={poopConsistency}
                                onValueChange={(v) => setPoopConsistency(v)}
                                style={styles.wheelFull}
                            >
                                <Picker.Item label="硬" value="硬" />
                                <Picker.Item label="普" value="普" />
                                <Picker.Item label="柔" value="柔" />
                                <Picker.Item label="水っぽい" value="水っぽい" />
                            </Picker>
                        </View>
                        <TextInput placeholder="メモ（任意）" value={note} onChangeText={setNote} style={styles.input} />
                    </>
                );
            case '離乳食': {
                const gramOptions = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
                return (
                    <>
                        <TextInput placeholder="食べたもの" value={menu} onChangeText={setMenu} style={styles.input} />
                        <Text style={styles.pickerLabel}>量（g）</Text>
                        <View style={styles.wheelRow}>
                            <Picker
                                selectedValue={amount || '50'}
                                onValueChange={(v) => setAmount(String(v))}
                                style={styles.wheelFull}
                            >
                                {gramOptions.map(v => <Picker.Item key={v} label={`${v} g`} value={String(v)} />)}
                            </Picker>
                        </View>
                        <TextInput placeholder="メモ（任意）" value={note} onChangeText={setNote} style={styles.input} />
                    </>
                );
            }
            case '体温': {
                const intTemps = Array.from({ length: 7 }, (_, i) => i + 35); // 35..41
                const decTemps = Array.from({ length: 10 }, (_, i) => i);    // .0.. .9
                const [tempInt, tempDec] = (temp ? String(temp).split('.') : ['36', '5']);
                return (
                    <>
                        <Text style={styles.pickerLabel}>体温（℃）</Text>
                        <View style={styles.doubleWheelRow}>
                            <Picker
                                selectedValue={tempInt || '36'}
                                onValueChange={(v) => { const d = (tempDec ?? '5'); setTemp(`${v}.${d}`); }}
                                style={styles.wheelHalf}
                            >
                                {intTemps.map(v => <Picker.Item key={v} label={`${v}`} value={`${v}`} />)}
                            </Picker>
                            <Text style={styles.dot}>.</Text>
                            <Picker
                                selectedValue={tempDec || '5'}
                                onValueChange={(v) => { const i = (tempInt ?? '36'); setTemp(`${i}.${v}`); }}
                                style={styles.wheelHalf}
                            >
                                {decTemps.map(v => <Picker.Item key={v} label={`${v}`} value={`${v}`} />)}
                            </Picker>
                        </View>
                        <TextInput placeholder="メモ（任意）" value={note} onChangeText={setNote} style={styles.input} />
                    </>
                );
            }
            case '身長': {
                const intHeights = Array.from({ length: 81 }, (_, i) => i + 40); // 40..120
                const decHeights = ['0', '5']; // .0 / .5
                const [hInt, hDecRaw] = (height ? String(height).split('.') : ['60', '0']);
                const hDec = hDecRaw === '5' ? '5' : '0';
                return (
                    <>
                        <Text style={styles.pickerLabel}>身長（cm）</Text>
                        <View style={styles.doubleWheelRow}>
                            <Picker
                                selectedValue={hInt || '60'}
                                onValueChange={(v) => { const d = hDec; setHeight(`${v}.${d}`); }}
                                style={styles.wheelHalf}
                            >
                                {intHeights.map(v => <Picker.Item key={v} label={`${v}`} value={`${v}`} />)}
                            </Picker>
                            <Text style={styles.dot}>.</Text>
                            <Picker
                                selectedValue={hDec}
                                onValueChange={(v) => { const i = (hInt ?? '60'); setHeight(`${i}.${v}`); }}
                                style={styles.wheelHalf}
                            >
                                {decHeights.map(v => <Picker.Item key={v} label={v} value={v} />)}
                            </Picker>
                        </View>
                        <TextInput placeholder="メモ（任意）" value={note} onChangeText={setNote} style={styles.input} />
                    </>
                );
            }
            case '体重': {
                const intWeights = Array.from({ length: 19 }, (_, i) => i + 2); // 2..20
                const decWeights = Array.from({ length: 10 }, (_, i) => i);    // .0.. .9
                const [wInt, wDec] = (weight ? String(weight).split('.') : ['6', '5']);
                return (
                    <>
                        <Text style={styles.pickerLabel}>体重（kg）</Text>
                        <View style={styles.doubleWheelRow}>
                            <Picker
                                selectedValue={wInt || '6'}
                                onValueChange={(v) => { const d = (wDec ?? '5'); setWeight(`${v}.${d}`); }}
                                style={styles.wheelHalf}
                            >
                                {intWeights.map(v => <Picker.Item key={v} label={`${v}`} value={`${v}`} />)}
                            </Picker>
                            <Text style={styles.dot}>.</Text>
                            <Picker
                                selectedValue={wDec || '5'}
                                onValueChange={(v) => { const i = (wInt ?? '6'); setWeight(`${i}.${v}`); }}
                                style={styles.wheelHalf}
                            >
                                {decWeights.map(v => <Picker.Item key={v} label={`${v}`} value={`${v}`} />)}
                            </Picker>
                        </View>
                        <TextInput placeholder="メモ（任意）" value={note} onChangeText={setNote} style={styles.input} />
                    </>
                );
            }
            default:
                return <TextInput placeholder="メモ（任意）" value={note} onChangeText={setNote} style={styles.input} />;
        }
    };

    return (
        <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>📋 {recordType}の記録</Text>
            {renderInputFields()}
            <Button title="記録する" onPress={onSave} />
            <View style={{ marginTop: 10 }}><Button title="キャンセル" onPress={onClose} color="#888" /></View>
        </View>
    );
};

const DebugButtons = ({ clearAllRecords }) => (
    <View style={styles.debugButtonsContainer}>
        <Button title="🛠 全削除" onPress={clearAllRecords} color="red" />
    </View>
);

// --- Main ---
export default function RecordScreen({ navigation }) {
    const [records, setRecords] = useState([]);
    const [currentDisplayDate, setCurrentDisplayDate] = useState(new Date());
    const [currentTime, setCurrentTime] = useState(new Date());
    const [appReady, setAppReady] = useState(false);
    const [name, setName] = useState('陽翔');
    const [age, setAge] = useState('4ヶ月10日');

    // 入力モーダル
    const [showRecordModal, setShowRecordModal] = useState(false);
    const [modalRecordType, setModalRecordType] = useState('ミルク');

    // 既存：日付ジャンプ用（ヘッダの真ん中）
    const [showDatePicker, setShowDatePicker] = useState(false);

    // 入力フォーム状態
    const [amount, setAmount] = useState('');
    const [note, setNote] = useState('');
    const [poopConsistency, setPoopConsistency] = useState('普');
    const [menu, setMenu] = useState('');
    const [temp, setTemp] = useState('');
    const [height, setHeight] = useState('');
    const [weight, setWeight] = useState('');

    // ▼▼▼ 新：時間確認“だけ”モーダル（カレンダーは出さない） ▼▼▼
    const [showTimeModal, setShowTimeModal] = useState(false);
    const now = new Date();
    const [timeHour, setTimeHour] = useState(now.getHours());
    const [timeMinute, setTimeMinute] = useState(Math.floor(now.getMinutes() / 5) * 5); // 5分刻み
    const [selectedRecordTime, setSelectedRecordTime] = useState(new Date());

    // 音声入力関連
    const [recording, setRecording] = useState(null);
    const [isProcessingVoice, setIsProcessingVoice] = useState(false);
    const [recognizedText, setRecognizedText] = useState('');
    const [parsedRecord, setParsedRecord] = useState(null);
    const [showConfirmModal, setShowConfirmModal] = useState(false);
    const ws = useRef(null);

    const today = getFormattedDate(currentDisplayDate);
    const isToday = getFormattedDate(new Date()) === today;

    // --- Data ---
    const loadRecords = useCallback(async () => {
        try {
            const rawData = await AsyncStorage.getItem('records');
            const recordsToLoad = rawData ? JSON.parse(rawData) : [];
            const cleaned = recordsToLoad
                .filter(item => item && item.id && item.time)
                .map(item => (!item.data ? { ...item, data: { ...item } } : item));
            setRecords(cleaned);
        } catch {
            Alert.alert('エラー', 'データの読み込みに失敗しました。');
        }
    }, []);

    const saveNewRecord = async (recordToSave) => {
        try {
            const existing = await AsyncStorage.getItem('records');
            const updated = [...(existing ? JSON.parse(existing) : []), recordToSave];
            await AsyncStorage.setItem('records', JSON.stringify(updated));
            await loadRecords();
        } catch {
            Alert.alert('失敗', '記録の保存に失敗しました');
        }
    };

    const saveManualRecord = () => {
        // 選択された時刻で当日の日付を使う（ユーザー要望：日付はその日でOK）
        const base = new Date();
        base.setHours(timeHour);
        base.setMinutes(timeMinute);
        base.setSeconds(0);
        base.setMilliseconds(0);
        setSelectedRecordTime(base);

        let data = {};
        switch (modalRecordType) {
            case 'ミルク': data = { amount, note }; break;
            case 'うんち': data = { consistency: poopConsistency, note }; break;
            case '離乳食': data = { menu, amount, note }; break;
            case '体温': data = { temp, note }; break;
            case '身長': data = { height, note }; break;
            case '体重': data = { weight, note }; break;
            default: data = { note };
        }
        const newRecord = { id: Date.now().toString(), type: modalRecordType, time: base.toISOString(), data };
        saveNewRecord(newRecord);
        setShowRecordModal(false);
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
                        } catch {
                            Alert.alert('失敗', '記録の削除に失敗しました。');
                        }
                    },
                    style: 'destructive',
                },
            ]
        );
    };

    // --- Voice (省略ロジックはそのまま) ---
    const startRecording = async () => {
        try {
            await Audio.requestPermissionsAsync();
            await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
            const rec = new Audio.Recording();
            await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
            await rec.startAsync();
            setRecording(rec);
        } catch (err) { console.error('録音開始に失敗:', err); }
    };
    const stopRecording = async () => {
        if (!recording) return;
        try {
            await recording.stopAndUnloadAsync();
            const uri = recording.getURI();
            setRecording(null);
            if (uri) connectWebSocketAndSend(uri);
        } catch (error) { console.error('録音停止に失敗:', error); }
    };
    const connectWebSocketAndSend = (uri) => {
        const wsUrl = 'ws://10.0.2.2:8090';
        ws.current = new WebSocket(wsUrl);
        setIsProcessingVoice(true);
        setRecognizedText('');

        ws.current.onopen = async () => {
            try {
                const base64Audio = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
                ws.current.send(JSON.stringify({ audio: base64Audio }));
            } catch (error) {
                Alert.alert("送信エラー", "音声ファイルの読み込みまたは送信に失敗しました。");
                setIsProcessingVoice(false);
                if (ws.current) ws.current.close();
            }
        };
        ws.current.onmessage = (e) => {
            try {
                const message = JSON.parse(e.data);
                if (message.text) {
                    setRecognizedText(message.text);
                    parseTextWithLLM(message.text);
                } else if (message.error) {
                    Alert.alert("音声認識エラー", message.error);
                }
            } catch {
                // noop
            }
            if (ws.current) ws.current.close();
        };
        ws.current.onerror = () => {
            Alert.alert("通信エラー", `サーバー(${wsUrl})との接続に失敗しました。`);
            setIsProcessingVoice(false);
        };
        ws.current.onclose = () => {};
    };
    const parseTextWithLLM = async (text) => {
        const currentDate = new Date().toISOString();
        const prompt = `
            以下のユーザー発話から育児記録の情報を抽出し、JSON形式で出力してください。
            現在の時刻は「${currentDate}」です。これを基準に時間を解釈してください。
            もし発話に時刻の指定がなければ、必ずこの現在時刻を使用してください。
            時間は「YYYY-MM-DDTHH:mm:ss.sssZ」のISO 8601形式で出力してください。
            記録の種類(type)は「ミルク」「うんち」「おしっこ」「寝る」「起きる」「離乳食」「体温」「身長」「体重」「入浴」「その他」のいずれかです。
            
            # 発話内容:
            "${text}"

            # 出力形式 (JSON):
            {
              "type": "記録の種類",
              "time": "解釈したISO 8601形式の時間",
              "data": {
                "amount": "量(mlやgなど)",
                "note": "メモ",
                "height": "身長(cm)",
                "weight": "体重(kg)"
              }
            }
        `;
        const apiKey = GEMINI_API_KEY; 
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        const payload = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } };

        try {
            const res = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!res.ok) throw new Error(`APIリクエスト失敗: ${res.status}`);
            const result = await res.json();
            const content = result?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!content) throw new Error("LLMから予期しない形式の応答がありました。");
            const parsedJson = JSON.parse(content);
            setParsedRecord({ id: Date.now().toString(), ...parsedJson });
            setShowConfirmModal(true);
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

    // ▼▼▼ 修正：まず“時間確認モーダル”（自作の時間ホイール）を出してから入力モーダル ▼▼▼
    const openRecordModal = (type) => {
        setModalRecordType(type);
        // 入力初期化
        setAmount('');
        setNote('');
        setPoopConsistency('普');
        setMenu('');
        setTemp('');
        setHeight('');
        setWeight('');
        // 時刻は“今”を初期値（5分刻み丸め）
        const n = new Date();
        const roundedMin = Math.floor(n.getMinutes() / 5) * 5;
        setTimeHour(n.getHours());
        setTimeMinute(roundedMin);
        setShowTimeModal(true); // ← まず時間選択
    };

    // 既存：日付ジャンプ（ヘッダ中央タップで出るやつ）
    const onDateChange = (event, selectedDate) => {
        const newDate = selectedDate || currentDisplayDate;
        setShowDatePicker(Platform.OS === 'ios');
        setCurrentDisplayDate(newDate);
    };

    // Effects
    useEffect(() => {
        const id = setInterval(() => setCurrentTime(new Date()), 60000);
        return () => clearInterval(id);
    }, []);
    useFocusEffect(useCallback(() => {
        InteractionManager.runAfterInteractions(() => {
            loadRecords().then(() => setAppReady(true));
        });
    }, [loadRecords]));

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
                <TouchableOpacity onPress={() => setShowDatePicker(true)}><Text style={styles.date}>{today}{isToday ? ' (今日)' : ''}</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => setCurrentDisplayDate(d => new Date(d.setDate(d.getDate() + 1)))} style={styles.dateNavButton}><Text style={styles.dateNavButtonText}>翌日 ▶️</Text></TouchableOpacity>
            </View>
            
            {showDatePicker && (
                <DateTimePicker
                    testID="dateTimePicker"
                    value={currentDisplayDate}
                    mode="date"
                    is24Hour={true}
                    display="default"
                    onChange={onDateChange}
                />
            )}

            <ScrollView style={styles.mainContentScrollView}>
                <View style={styles.timelineContainer}>
                    {todayRecords.length === 0 ? (
                        <Text style={styles.empty}>📌 今日の記録はまだありません</Text>
                    ) : (
                        <FlatList
                            data={Array.from({ length: 24 }, (_, i) => i)}
                            keyExtractor={(hour) => hour.toString()}
                            renderItem={({ item: hour }) => {
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
                                                            {record.data.height ? ` 📏 ${record.data.height} cm` : ''}
                                                            {record.data.weight ? ` ⚖️ ${record.data.weight} kg` : ''}
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
                        <View style={styles.statColumn}>
                            <View style={styles.verticalBarsWrapper}>
                                <View style={[styles.verticalBar, styles.barAverage, { height: `${(average7DayAverage.milk / maxMilk) * 90}%` }]} />
                                <View style={[styles.verticalBar, styles.barToday, { height: `${(todaySummary.milk / maxMilk) * 90}%` }]} />
                            </View>
                            <Text style={styles.barValueSmall}>{ICONS['ミルク']} {todaySummary.milk}ml</Text>
                            <Text style={styles.barValueSmall}>Avg: {average7DayAverage.milk}ml</Text>
                        </View>
                        <View style={styles.statColumn}>
                            <View style={styles.verticalBarsWrapper}>
                                <View style={[styles.verticalBar, styles.barAverage, { height: `${(average7DayAverage.poop / maxPoop) * 90}%` }]} />
                                <View style={[styles.verticalBar, styles.barToday, { height: `${(todaySummary.poop / maxPoop) * 90}%` }]} />
                            </View>
                            <Text style={styles.barValueSmall}>{ICONS['うんち']} {todaySummary.poop}回</Text>
                            <Text style={styles.barValueSmall}>Avg: {average7DayAverage.poop}回</Text>
                        </View>
                        <View style={styles.statColumn}>
                            <View style={styles.verticalBarsWrapper}>
                                <View style={[styles.verticalBar, styles.barAverage, { height: `${(average7DayAverage.sleep / maxSleep) * 90}%` }]} />
                                <View style={[styles.verticalBar, styles.barToday, { height: `${(todaySummary.sleep / maxSleep) * 90}%` }]} />
                            </View>
                            <Text style={styles.barValueSmall}>{ICONS['寝る']} {Math.floor(todaySummary.sleep / 60)}h{todaySummary.sleep % 60}m</Text>
                            <Text style={styles.barValueSmall}>Avg: {Math.floor(average7DayAverage.sleep / 60)}h{average7DayAverage.sleep % 60}m</Text>
                        </View>
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
            
            {/* ▼▼▼ 時間選択モーダル（半透明の背面＋白カード / 背景は見える） ▼▼▼ */}
           {/* ▼▼▼ 時間選択モーダル（中央カードに変更） ▼▼▼ */}
<Modal
  visible={showTimeModal}
  onRequestClose={() => setShowTimeModal(false)}
  transparent
  animationType="fade"
>
  <Pressable style={styles.backdrop} onPress={() => setShowTimeModal(false)} />
  <View style={styles.centerLayer}>
    <View style={styles.modalCard}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={styles.modalTitle}>記録する時間</Text>
        <TouchableOpacity
          onPress={() => {
            const n = new Date();
            setTimeHour(n.getHours());
            setTimeMinute(Math.floor(n.getMinutes() / 5) * 5);
          }}
        >
          <Text style={styles.nowButton}>今にする</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sheetSubTitle}>日付は今日のまま。時間だけ選べばOKです。</Text>

      <View style={styles.timePickersRow}>
        <View style={styles.timeWheel}>
          <Text style={styles.timeLabel}>時</Text>
<Picker
   selectedValue={timeHour}
   onValueChange={(v) => setTimeHour(v)}
   style={styles.wheelFull}
   itemStyle={styles.pickerItemIOS}
 >
   {Array.from({ length: 24 }, (_, i) => i).map((h) => (
     <Picker.Item key={`h-${h}`} label={String(h).padStart(2,'0')} value={h} />
   ))}
 </Picker>
        </View>

        <View style={styles.timeWheel}>
          <Text style={styles.timeLabel}>分（5分刻み）</Text>
  <Picker
   selectedValue={timeMinute}
   onValueChange={(v) => setTimeMinute(v)}
   style={styles.wheelFull}
   itemStyle={styles.pickerItemIOS}
 >
   {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
     <Picker.Item key={`m-${m}`} label={String(m).padStart(2,'0')} value={m} />
   ))}
 </Picker>
        </View>
      </View>

      <View style={styles.sheetButtonsColumn}>
        <TouchableOpacity style={[styles.fullWidthBtn, styles.btnSecondary]} onPress={() => setShowTimeModal(false)}>
          <Text style={[styles.fullWidthBtnText, { color: '#333' }]}>キャンセル</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.fullWidthBtn, styles.btnPrimary]}
          onPress={() => {
            setShowTimeModal(false);
            setShowRecordModal(true);
          }}
        >
          <Text style={styles.fullWidthBtnText}>OK</Text>
        </TouchableOpacity>
      </View>
    </View>
  </View>
</Modal>

            {/* ▼▼▼ 入力モーダル（半透明の背面＋白カード） ▼▼▼ */}
            <Modal
                animationType="slide"
                transparent={true}
                visible={showRecordModal}
                onRequestClose={() => setShowRecordModal(false)}
            >
                <Pressable style={styles.backdrop} onPress={() => setShowRecordModal(false)} />
                <View style={styles.centerLayer}>
                    <RecordInputForm
                        recordType={modalRecordType}
                        amount={amount} setAmount={setAmount}
                        note={note} setNote={setNote}
                        poopConsistency={poopConsistency} setPoopConsistency={setPoopConsistency}
                        menu={menu} setMenu={setMenu}
                        temp={temp} setTemp={setTemp}
                        height={height} setHeight={setHeight}
                        weight={weight} setWeight={setWeight}
                        onSave={saveManualRecord}
                        onClose={() => setShowRecordModal(false)}
                    />
                </View>
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

            {/* 解析確認（半透明の背面＋白カード） */}
            <Modal animationType="slide" transparent={true} visible={showConfirmModal} onRequestClose={handleCancelSave}>
                <Pressable style={styles.backdrop} onPress={handleCancelSave} />
                <View style={styles.centerLayer}>
                    <View style={styles.modalCard}>
                        <Text style={styles.modalTitle}>以下の内容で記録しますか？</Text>
                        {parsedRecord && (
                            <View style={styles.confirmDetails}>
                                <Text style={styles.confirmText}>種類: {ICONS[parsedRecord.type] || '❓'} {parsedRecord.type}</Text>
                                <Text style={styles.confirmText}>時間: {new Date(parsedRecord.time).toLocaleString('ja-JP')}</Text>
                                {parsedRecord.data?.amount && <Text style={styles.confirmText}>量: {parsedRecord.data.amount}</Text>}
                                {parsedRecord.data?.height && <Text style={styles.confirmText}>身長: {parsedRecord.data.height} cm</Text>}
                                {parsedRecord.data?.weight && <Text style={styles.confirmText}>体重: {parsedRecord.data.weight} kg</Text>}
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
    childNameTextHeader: { fontSize: 16, fontWeight: 'bold', color: '#333' },
    childAgeTextHeader: { fontSize: 14, color: '#555', marginLeft: 4 },
    debugButtonsContainer: { flexDirection: 'row' },

    recognizedTextView: { backgroundColor: '#e6f7ff', padding: 10, marginHorizontal: 14, borderRadius: 8, marginTop: 5 },
    recognizedTextLabel: { fontSize: 12, color: '#007AFF', fontWeight: 'bold', marginBottom: 4 },
    recognizedTextContent: { fontSize: 16, color: '#333' },

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

    // ▼▼▼ モーダルの共通：背面は半透明、カードは白（背面は見えるが内容は読みやすい） ▼▼▼
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
    centerLayer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    modalCard: { backgroundColor: 'white', borderRadius: 16, paddingHorizontal: 16, paddingVertical: 16, width: '92%', maxWidth: 520, maxHeight: '80%', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 6 },

    modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 16, color: '#333' },
    input: { backgroundColor: '#f0f0f0', borderRadius: 10, padding: 12, fontSize: 16, marginBottom: 20, width: '100%' },

    // 追加入力UI
    pickerLabel: { fontSize: 14, color: '#333', marginBottom: 6, marginTop: 4, fontWeight: '600' },
    wheelRow: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#eee', overflow: 'hidden' },
    doubleWheelRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#eee', overflow: 'hidden' },
    wheelFull: { width: '100%', height: 180 },
    wheelHalf: { width: '48%', height: 180 },
    dot: { fontSize: 22, paddingHorizontal: 4, color: '#333' },

    // ボトムシート（時間選択）
    bottomSheet: {
        position: 'absolute',
        left: 0, right: 0, bottom: 0,
        backgroundColor: '#fff',
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        padding: 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.2,
        shadowRadius: 6,
        elevation: 12,
    },
    sheetButtonsColumn: {
  marginTop: 12,
  gap: 10,
},
fullWidthBtn: {
  width: '100%',
  paddingVertical: 14,
  borderRadius: 10,
  alignItems: 'center',
  justifyContent: 'center',
},
btnPrimary: {
  backgroundColor: '#6C63FF',
},
btnSecondary: {
  backgroundColor: '#e9e9ef',
},
fullWidthBtnText: {
  color: '#fff',
  fontSize: 16,
  fontWeight: 'bold',
},
nowButton: { color: '#007AFF', fontWeight: 'bold', fontSize: 14 }, // 既存を少しだけ太字＋サイズUP
    sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    sheetTitle: { fontSize: 18, fontWeight: 'bold', color: '#333' },
    sheetSubTitle: { color: '#666', marginTop: 6, marginBottom: 8 },
    nowButton: { color: '#007AFF', fontWeight: 'bold' },
    timePickersRow: { flexDirection: 'row', gap: 12, marginTop: 6 },
    timeWheel: { flex: 1 },
    timeLabel: { fontSize: 12, color: '#666', marginLeft: 4, marginBottom: 6 },

    sheetButtons: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },

    currentTimeLine: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: 'red', zIndex: 1 },
    micButton: { position: 'absolute', bottom: 80, right: 20, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 32, padding: 6, zIndex: 100 },

    processingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center' },
    processingText: { color: '#fff', marginTop: 10, fontSize: 16 },
    recognizedTextPreview: { color: '#fff', marginTop: 20, paddingHorizontal: 20, fontSize: 18, fontStyle: 'italic' },

    confirmDetails: { marginBottom: 20, alignItems: 'flex-start' },
    confirmText: { fontSize: 16, marginBottom: 5 },
    modalButtons: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
});