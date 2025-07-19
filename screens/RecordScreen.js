import React, { useEffect, useState, useCallback } from 'react';
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
    Modal, // Modal をインポート
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import DateTimePicker from '@react-native-community/datetimepicker'; 
// import { v4 as uuidv4 } from 'uuid'; // uuid のインポートをコメントアウト
import { InteractionManager } from 'react-native';
import { useFocusEffect } from '@react-navigation/native'; 

const screenWidth = Dimensions.get('window').width;

// 記録タイプごとのアイコン定義
const ICONS = {
    ミルク: '🍼',
    うんち: '💩', // 排泄から分離
    おしっこ: '💧', // 排泄から分離
    睡眠: '😴',
    離乳食: '🍚', 
    体温: '🌡️',
    入浴: '🛁', 
    その他: '➕', // モーダルを開くための汎用アイコン
};

// 平均データ計算ヘルパー関数 (VictoryChartがないため、この関数は現在使用されませんが、残しておきます)
const getAverageData = (records, today) => {
    const categorySums = {};
    const counts = {};
    records.forEach((r) => {
        const date = r.time.split(' ')[0];
        if (date === today) return; 

        const type = r.type;
        const amount = Number(r.data?.amount ?? 1); 

        categorySums[type] = (categorySums[type] || 0) + amount;
        counts[type] = (counts[type] || 0) + 1;
    });

    const avg = {};
    Object.keys(categorySums).forEach((k) => {
        avg[k] = categorySums[k] / counts[k];
    });
    return avg;
};

// ミルク量選択ピッカーコンポーネント
const AmountPicker = ({ value, onValueChange }) => {
    const data = Array.from({ length: 301 / 5 }, (_, i) => i * 5); // 0, 5, 10, ..., 300ml

    const getItemLayout = useCallback((data, index) => ({
        length: 40, // 各アイテムの高さ
        offset: 40 * index,
        index,
    }), []);

    // 現在の値に最も近い5ml刻みのインデックスを計算して初期スクロール位置とする
    const initialScrollIndex = data.indexOf(value - (value % 5)); 

    return (
        <View style={amountPickerStyles.container}>
            <FlatList
                data={data}
                keyExtractor={(item) => item.toString()}
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={[
                            amountPickerStyles.item,
                            item === value && amountPickerStyles.selectedItem,
                        ]}
                        onPress={() => onValueChange(item.toString())}
                    >
                        <Text
                            style={[
                                amountPickerStyles.text,
                                item === value && amountPickerStyles.selectedText,
                            ]}
                        >
                            {item}ml
                        </Text>
                    </TouchableOpacity>
                )}
                initialScrollIndex={initialScrollIndex > -1 ? initialScrollIndex : 0}
                getItemLayout={getItemLayout}
                showsVerticalScrollIndicator={false}
                // snapToInterval={40} // オプション: 各アイテムにスナップ
                // decelerationRate="fast" // オプション: 減速を速くする
            />
        </View>
    );
};

// 記録入力フォームコンポーネント (Modal内で使用)
const RecordInputForm = ({ 
    recordType, setRecordType, amount, setAmount, note, setNote, 
    poopConsistency, setPoopConsistency, 
    menu, setMenu, temp, setTemp, 
    startTime, setStartTime, endTime, setEndTime, 
    showStartPicker, setShowStartPicker, showEndPicker, setShowEndPicker,
    bathTime, setBathTime, showBathPicker, setShowBathPicker,
    onSave, 
    onClose 
}) => {
    const renderInputFields = () => {
        switch (recordType) {
            case 'ミルク':
                return (<>
                    <AmountPicker value={Number(amount)} onValueChange={setAmount} />
                    <TextInput placeholder="メモ" value={note} onChangeText={setNote} style={styles.input} />
                </>);
            case 'うんち': 
                return (<>
                    <Picker
                        selectedValue={poopConsistency}
                        onValueChange={(itemValue) => setPoopConsistency(itemValue)}
                        style={[styles.input, { width: '100%' }]} 
                    >
                        <Picker.Item label="硬" value="硬" />
                        <Picker.Item label="普" value="普" />
                        <Picker.Item label="柔" value="柔" />
                        <Picker.Item label="水っぽい" value="水っぽい" />
                    </Picker>
                    <TextInput placeholder="メモ" value={note} onChangeText={setNote} style={styles.input} />
                </>);
            case 'おしっこ': 
                return (<>
                    <TextInput placeholder="メモ" value={note} onChangeText={setNote} style={styles.input} />
                </>);
            case '睡眠':
                return (<>
                    <Button title={`開始: ${startTime.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`} onPress={() => setShowStartPicker(true)} />
                    {showStartPicker && <DateTimePicker value={startTime} mode="time" is24Hour display="default" onChange={(e, date) => { setShowStartPicker(Platform.OS === 'ios'); if (date) setStartTime(date); }} />}
                    <Button title={`終了: ${endTime.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`} onPress={() => setShowEndPicker(true)} />
                    {showEndPicker && <DateTimePicker value={endTime} mode="time" is24Hour display="default" onChange={(e, date) => { setShowEndPicker(Platform.OS === 'ios'); if (date) setEndTime(date); }} />}
                    <TextInput placeholder="メモ" value={note} onChangeText={setNote} style={styles.input} />
                </>);
            case '離乳食':
                return (<>
                    <TextInput placeholder="食べたもの" value={menu} onChangeText={setMenu} style={styles.input} />
                    <TextInput placeholder="量（g）" value={amount} onChangeText={setAmount} keyboardType="numeric" style={styles.input} />
                    <TextInput placeholder="メモ" value={note} onChangeText={setNote} style={styles.input} />
                </>);
            case '体温':
                return (<>
                    <TextInput placeholder="体温（℃）" value={temp} onChangeText={setTemp} keyboardType="numeric" style={styles.input} />
                    <TextInput placeholder="メモ" value={note} onChangeText={setNote} style={styles.input} />
                </>);
            case '入浴':
                return (<>
                    <Button title={`入浴時刻: ${bathTime.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`} onPress={() => setShowBathPicker(true)} />
                    {showBathPicker && <DateTimePicker value={bathTime} mode="time" is24Hour display="default" onChange={(e, date) => { setShowBathPicker(Platform.OS === 'ios'); if (date) setBathTime(date); }} />}
                    <TextInput placeholder="メモ" value={note} onChangeText={setNote} style={styles.input} />
                </>);
            default:
                return null;
        }
    };

    return (
        <View style={[styles.modalContent, { alignSelf: 'stretch' }]}> 
            <Text style={styles.modalTitle}>📋 記録入力</Text>
            {renderInputFields()}
            <Button title="記録する" onPress={onSave} />
            <View style={{ marginTop: 10 }}>
                <Button title="キャンセル" onPress={onClose} color="#888" />
            </View>
        </View>
    );
};

// デバッグボタンコンポーネント
const DebugButtons = ({ clearAllRecords, navigation }) => {
    return (
        <View style={styles.debugButtons}>
            <Button
                title="🛠 全記録を削除 (デバッグ用)"
                onPress={clearAllRecords}
                color="red"
            />
            <Button
                title="🛠 Debug画面へ"
                onPress={() => navigation.navigate('Debug')}
            />
        </View>
    );
};


export default function RecordScreen({ navigation }) {
    // 記録入力フォームのステート
    const [recordType, setRecordType] = useState('ミルク'); 
    const [amount, setAmount] = useState('');
    const [note, setNote] = useState('');
    const [poopConsistency, setPoopConsistency] = useState('普'); 
    const [menu, setMenu] = useState(''); 
    const [temp, setTemp] = useState(''); 
    const [startTime, setStartTime] = useState(new Date()); 
    const [endTime, setEndTime] = useState(new Date()); 
    const [showStartPicker, setShowStartPicker] = useState(false);
    const [showEndPicker, setShowEndPicker] = useState(false);
    const [bathTime, setBathTime] = useState(new Date()); 
    const [showBathPicker, setShowBathPicker] = useState(false);

    // 記録一覧と表示関連のステート
    const [records, setRecords] = useState([]);
    // 現在表示している日付 (Dateオブジェクト)
    const [currentDisplayDate, setCurrentDisplayDate] = useState(new Date()); 
    // 日付ピッカーの表示/非表示
    const [showDatePicker, setShowDatePicker] = useState(false);
    // 現在の時刻 (ライン表示用)
    const [currentTime, setCurrentTime] = useState(new Date());

    // currentDisplayDateから表示用の日付文字列を生成
    const today = currentDisplayDate.getFullYear() + '-' + 
                                       String(currentDisplayDate.getMonth() + 1).padStart(2, '0') + '-' + 
                                       String(currentDisplayDate.getDate()).padStart(2, '0');

    const [name, setName] = useState('陽翔'); 
    const [age, setAge] = useState('4ヶ月10日'); 
    const [appReady, setAppReady] = useState(false); 

    // モーダル関連のステート
    const [showRecordModal, setShowRecordModal] = useState(false);
    const [modalRecordType, setModalRecordType] = useState('ミルク'); 

    // 現在時刻ラインを1分ごとに更新
    useEffect(() => {
        const intervalId = setInterval(() => {
            setCurrentTime(new Date());
        }, 60 * 1000); // 1分ごとに更新

        return () => clearInterval(intervalId); // クリーンアップ
    }, []);

    // 記録を保存する関数
    const saveRecord = async () => {
        console.log('🐛 saveRecord が呼ばれました');
        console.log('DEBUG: 1. saveRecord関数開始'); 

        console.log('DEBUG: 2. Current today state:', today); 
        const now = new Date();
        let data = {};
        let typeLabel = modalRecordType; 

        console.log('DEBUG: 3. 変数初期化後');

        // 選択された記録タイプに応じてデータを整形
        console.log('DEBUG: 4. switchケース開始');
        switch (modalRecordType) { 
            case 'ミルク':
                data = { amount: amount, note: note };
                break;
            case 'うんち': 
                data = { consistency: poopConsistency, note: note };
                break;
            case 'おしっこ': 
                data = { note: note };
                break;
            case '睡眠':
                data = {
                    start: startTime.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
                    end: endTime.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
                    note: note
                };
                break;
            case '離乳食':
                data = { menu: menu, amount: amount, note: note };
                break;
            case '体温':
                data = { temp: temp, note: note };
                break;
            case '入浴':
                data = {
                    time: bathTime.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
                    note: note
                };
                break;
            default:
                data = { note: note };
        }
        console.log('DEBUG: 5. switchケース終了, data:', data);

        // format関数の代わりに手動で日付と時刻をフォーマット
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const formattedTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

        const newRecord = {
            id: Date.now().toString(), 
            type: typeLabel,
            time: formattedTime, 
            data: data
        };
        console.log('DEBUG: 6c. newRecord作成完了, newRecord.time:', newRecord.time); 

        try {
            console.log('DEBUG: 7. tryブロック開始');
            console.log('DEBUG: 8. About to call AsyncStorage.getItem'); 
            const existing = await AsyncStorage.getItem('records');
            console.log('DEBUG: 9. AsyncStorage.getItem completed, existing:', existing);
            const parsed = existing ? JSON.parse(existing) : [];
            console.log('DEBUG: 10. parsed data:', parsed);

            const updated = [...parsed, newRecord];
            const stringified = JSON.stringify(updated);
            console.log('DEBUG: 11. stringified data:', stringified);

            console.log('DEBUG: 12. About to call AsyncStorage.setItem'); 
            await AsyncStorage.setItem('records', stringified);
            console.log('DEBUG: 13. AsyncStorage.setItem completed.'); 
            console.log('✅ 保存成功: updated records');
            console.log('📦 保存内容:', stringified);

            // 保存後にフォームをリセット 
            setAmount('');
            setNote('');
            setPoopConsistency('普'); 
            setMenu('');
            setTemp('');
            setStartTime(new Date()); 
            setEndTime(new Date()); 
            setBathTime(new Date()); 
            console.log('DEBUG: 14. フォームリセット完了');

            await loadRecords(); // 一覧を再読み込みして反映
            Alert.alert('成功', '新しい記録を保存しました');
            console.log('DEBUG: 15. saveRecord関数終了');
        } catch (e) {
            console.error('❌ 保存エラー (catchブロック内):', e); 
            Alert.alert('失敗', '保存に失敗しました');
        }
    };

    // 記録保存とモーダルを閉じる処理をまとめた関数
    const saveRecordAndCloseModal = async () => {
        // モーダルを閉じる処理を先に実行
        setShowRecordModal(false); 
        console.log('DEBUG: saveRecordAndCloseModal - モーダルを閉じます'); 
        await saveRecord();
        console.log('DEBUG: saveRecordAndCloseModal - saveRecordが完了しました'); 
    };

    // AsyncStorageから記録を読み込む関数
    const loadRecords = async () => {
        try {
            const rawData = await AsyncStorage.getItem('records');
            console.log("🧪 AsyncStorageから取得したraw data:", rawData); 
            
            const parsed = rawData ? JSON.parse(rawData) : [];

            const cleanedAndNormalized = parsed.filter(item => item && typeof item === 'object' && item.id && item.time)
                                              .map(item => {
                                                  // 古い「排泄」タイプを新しい「うんち」または「おしっこ」タイプに変換
                                                  if (item.type === '排泄') {
                                                      if (item.data && item.data.type === 'うんち') {
                                                          return { ...item, type: 'うんち', data: { consistency: item.data.consistency, note: item.data.note } };
                                                      } else if (item.data && item.data.type === 'おしっこ') {
                                                          return { ...item, type: 'おしっこ', data: { note: item.data.note } };
                                                      } else if (!item.data && item.style) { // dataがなく、styleがある古い形式
                                                          if (item.style === 'うんち') {
                                                              return { ...item, type: 'うんち', data: { consistency: item.consistency, note: item.note } }; 
                                                          } else if (item.style === 'おしっこ') {
                                                              return { ...item, type: 'おしっこ', data: { note: item.note } };
                                                          }
                                                      }
                                                  }
                                                  // dataプロパティがない場合の互換性処理（既存のロジック）
                                                  if (!item.data) {
                                                      const { id, type, time, amount, note, style, menu, temp, start, end, ...rest } = item;
                                                      return {
                                                          id,
                                                          type,
                                                          time,
                                                          data: { amount, note, style, menu, temp, start, end, ...rest },
                                                      };
                                                  }
                                                  return item;
                                              });

            cleanedAndNormalized.sort((a, b) => new Date(b.time) - new Date(a.time));

            console.log("🧪 正規化されたrecords:", cleanedAndNormalized);
            setRecords(cleanedAndNormalized);
        } catch (err) {
            console.error('❌ AsyncStorage 読み込みエラー:', err);
            Alert.alert('エラー', 'データの読み込みに失敗しました。アプリの再起動や、必要であればデータのクリアを試してください。');
        }
    };

    // デバッグ用: AsyncStorageのデータをすべてクリアする関数
    const clearAllRecords = async () => {
        Alert.alert(
            '確認',
            'すべての記録を削除しますか？この操作は元に戻せません。',
            [
                { text: 'キャンセル', style: 'cancel' },
                {
                    text: '削除',
                    onPress: async () => {
                        try {
                            await AsyncStorage.removeItem('records');
                            setRecords([]); 
                            Alert.alert('成功', 'すべての記録を削除しました。');
                            console.log('🧹 recordsキーを削除しました。');
                        } catch (e) {
                            console.error('❌ 記録削除エラー:', e);
                            Alert.alert('失敗', '記録の削除に失敗しました。');
                        }
                    },
                    style: 'destructive',
                },
            ],
            { cancelable: true }
        );
    };

    // 記録モーダルを開く関数
    const openRecordModal = (type) => {
        setModalRecordType(type);
        // モーダルを開く前に、排泄関連のステートをリセット
        if (type === 'うんち') {
            setPoopConsistency('普'); 
        }
        setAmount(''); 
        setNote('');
        setMenu('');
        setTemp('');
        setStartTime(new Date());
        setEndTime(new Date());
        setBathTime(new Date());
        setShowRecordModal(true);
    };

    // 前日へ移動する関数
    const goToPreviousDay = () => {
        const newDate = new Date(currentDisplayDate);
        newDate.setDate(newDate.getDate() - 1);
        setCurrentDisplayDate(newDate);
    };

    // 翌日へ移動する関数
    const goToNextDay = () => {
        const newDate = new Date(currentDisplayDate);
        newDate.setDate(newDate.getDate() + 1);
        setCurrentDisplayDate(newDate);
    };

    // 日付ピッカーで日付が選択されたときの処理
    const onDateChange = (event, selectedDate) => {
        const currentDate = selectedDate || currentDisplayDate;
        setShowDatePicker(Platform.OS === 'ios'); 
        setCurrentDisplayDate(currentDate);
    };


    // 画面が表示されるたび、または表示日付が変更されるたびに記録を読み込む
    useFocusEffect(
        useCallback(() => {
            loadRecords();
        }, [currentDisplayDate]) 
    );

    // アプリ準備完了のフラグ
    useEffect(() => {
        InteractionManager.runAfterInteractions(() => {
            setAppReady(true);
        });
    }, []);

    // 現在表示中の日付の記録のみをフィルタリング
    const todayRecords = records.filter((r) => {
        const recordDate = r.time.split(' ')[0]; 
        console.log(`Filtering: Record Time: ${r.time}, Record Date: ${recordDate}, Today: ${today}, Match: ${recordDate === today}`);
        return recordDate === today;
    });
    console.log("🧪 フィルタリング後のtodayRecords:", todayRecords);
    console.log("🧪 todayRecordsの長さ:", todayRecords.length);

    // 平均データを計算 (VictoryChartがないため、このデータは現在使用されませんが、残しておきます)
    const avgData = getAverageData(records, today);

    // アプリ準備中の表示
    if (!appReady) {
        return (
            <View style={styles.container}>
                <Text>⏳ 準備中...</Text>
            </View>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            {/* 🔝 ナビゲーション */}
            <View style={styles.topBar}>
                <TouchableOpacity onPress={() => navigation.navigate('Chat')}>
                    <Text style={styles.homeLink}>🏠 ホームへ</Text>
                </TouchableOpacity>
            </View>

            {/* 赤ちゃんの情報 */}
            <Text style={styles.title}>
                {name.toString()}（{age.toString()}）
            </Text>

            {/* 日付ナビゲーションと日付表示 */}
            <View style={styles.dateNavigation}>
                <TouchableOpacity onPress={goToPreviousDay} style={styles.dateNavButton}>
                    <Text style={styles.dateNavButtonText}>◀️ 前日へ</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setShowDatePicker(true)}>
                    <Text style={styles.date}>{today}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={goToNextDay} style={styles.dateNavButton}>
                    <Text style={styles.dateNavButtonText}>翌日へ ▶️</Text>
                </TouchableOpacity>
            </View>
            

            {/* 日付ピッカーモーダル */}
            {showDatePicker && (
                <DateTimePicker
                    value={currentDisplayDate}
                    mode="date"
                    display="default"
                    onChange={onDateChange}
                />
            )}
            

            {/* タイムライン表示部分 */}
            <View style={styles.timelineContainer}>
                <Text style={styles.sectionTitle}>🗂 今日の記録</Text>
                {todayRecords.length === 0 ? (
                    <Text style={styles.empty}>📌 今日の記録がまだありません</Text>
                ) : (
                    <FlatList
                        data={Array.from({ length: 24 }, (_, i) => i)} // Hours 0-23
                        keyExtractor={(hour) => hour.toString()}
                        renderItem={({ item: hour }) => {
                            const recordsInThisHour = todayRecords.filter(record => {
                                const recordHour = new Date(record.time).getHours();
                                return recordHour === hour;
                            });

                            // 現在の時刻ラインの表示判定と位置計算
                            const isCurrentHour = hour === currentTime.getHours() &&
                                currentDisplayDate.toDateString() === new Date().toDateString(); // 今日表示している場合のみ
                            const lineTopPosition = (currentTime.getMinutes() / 60) * styles.hourSlot.minHeight; // hourSlotのminHeightを基準に計算

                            return (
                                <View style={styles.hourSlot}>
                                    <Text style={styles.hourLabel}>{hour.toString()}</Text>
                                    <View style={styles.recordsInHourContainer}>
                                        {recordsInThisHour.length > 0 ? (
                                            recordsInThisHour.map(record => {
                                                const recordMinute = new Date(record.time).getMinutes();
                                                const displayMinute = recordMinute.toString().padStart(2, '0');
                                                const recordData = record.data || {};

                                                return (
                                                    <View key={record.id} style={styles.timelineRecordItem}>
                                                        <Text style={styles.timelineRecordMinute}>{displayMinute}</Text>
                                                        <View style={styles.timelineRecordContentWrapper}>
                                                            <Text style={styles.timelineRecordContent}>
                                                                {(() => {
                                                                    let displayString = '';
                                                                    let icon = ICONS[record.type] ?? '📘'; 

                                                                    if (record.type === 'うんち') {
                                                                        displayString = `${icon} うんち (${recordData.consistency ?? '不明'})`;
                                                                    } else if (record.type === 'おしっこ') {
                                                                        displayString = `${icon} おしっこ`;
                                                                    } else if (record.type === '排泄') { 
                                                                        if (recordData.type === 'うんち') {
                                                                            icon = ICONS['うんち'] ?? '💩'; 
                                                                            displayString = `${icon} 排泄 (うんち ${recordData.consistency ?? '不明'})`;
                                                                        } else if (recordData.type === 'おしっこ') {
                                                                            icon = ICONS['おしっこ'] ?? '💧'; 
                                                                            displayString = `${icon} 排泄 (おしっこ)`;
                                                                        } else {
                                                                            displayString = `${icon} 排泄`; 
                                                                        }
                                                                    } else {
                                                                        displayString = `${icon} ${record.type}`;
                                                                    }

                                                                    // 量の表示（ミルク、離乳食など）
                                                                    if ((record.type === 'ミルク' || record.type === '離乳食') && recordData.amount) {
                                                                        displayString += ` 📦 ${String(recordData.amount)}`;
                                                                    }
                                                                    // その他のデータ
                                                                    if (recordData.menu) {
                                                                        displayString += ` 🍽 ${String(recordData.menu)}`;
                                                                    }
                                                                    if (recordData.temp) {
                                                                        displayString += ` 🌡 ${String(recordData.temp)}`;
                                                                    }
                                                                    if (recordData.start && recordData.end) {
                                                                        displayString += ` 💤 ${String(recordData.start)}〜${String(recordData.end)}`;
                                                                    }
                                                                    if (recordData.time && record.type === '入浴') {
                                                                        displayString += ` 🛁 ${String(recordData.time)}`;
                                                                    }
                                                                    return displayString;
                                                                })()}
                                                            </Text>
                                                            {recordData.note ? <Text style={styles.timelineRecordNote}>📝 {recordData.note}</Text> : null}
                                                        </View>
                                                    </View>
                                                );
                                            })
                                        ) : (
                                            <View />
                                        )}
                                        {isCurrentHour && (
                                            <View style={[styles.currentTimeLine, { top: lineTopPosition }]} />
                                        )}
                                    </View>
                                </View>
                            );
                        }}
                        ListFooterComponent={() => (
                            <DebugButtons clearAllRecords={clearAllRecords} navigation={navigation} />
                        )}
                        style={styles.timelineFlatList}
                    />
                )}
            </View>

            {/* ⬇️ 入力カテゴリボタン（画面下部に固定） */}
            <View style={styles.bottomBar}>
                {/* ミルク、うんち、おしっこを明示的に配置 */}
                <TouchableOpacity key="ミルク" style={styles.iconButton} onPress={() => openRecordModal('ミルク')}>
                    <Text style={styles.iconText}>{ICONS['ミルク']}</Text>
                    <Text style={styles.iconLabel}>ミルク</Text>
                </TouchableOpacity>
                <TouchableOpacity key="うんち" style={styles.iconButton} onPress={() => openRecordModal('うんち')}>
                    <Text style={styles.iconText}>{ICONS['うんち']}</Text>
                    <Text style={styles.iconLabel}>うんち</Text>
                </TouchableOpacity>
                <TouchableOpacity key="おしっこ" style={styles.iconButton} onPress={() => openRecordModal('おしっこ')}>
                    <Text style={styles.iconText}>{ICONS['おしっこ']}</Text>
                    <Text style={styles.iconLabel}>おしっこ</Text>
                </TouchableOpacity>
                {/* その他のアイコンはループで生成（ミルク、うんち、おしっこ、その他を除く） */}
                {Object.entries(ICONS).map(([type, icon]) => (
                    (type !== 'ミルク' && type !== 'うんち' && type !== 'おしっこ' && type !== 'その他') && (
                        <TouchableOpacity key={type} style={styles.iconButton} onPress={() => openRecordModal(type)}>
                            <Text style={styles.iconText}>{icon}</Text>
                            <Text style={styles.iconLabel}>{type}</Text>
                        </TouchableOpacity>
                    )
                ))}
                <TouchableOpacity key="その他" style={styles.iconButton} onPress={() => openRecordModal('その他')}>
                    <Text style={styles.iconText}>{ICONS['その他']}</Text>
                    <Text style={styles.iconLabel}>その他</Text>
                </TouchableOpacity>
            </View>

            {/* 記録入力モーダル */}
            <Modal
                animationType="slide"
                transparent={true}
                visible={showRecordModal}
                onRequestClose={() => setShowRecordModal(false)}
            >
                <View style={styles.centeredView}>
                    <View style={styles.modalView}>
                        <RecordInputForm
                            recordType={modalRecordType} setRecordType={setModalRecordType}
                            amount={amount} setAmount={setAmount}
                            note={note} setNote={setNote}
                            poopConsistency={poopConsistency} setPoopConsistency={setPoopConsistency}
                            menu={menu} setMenu={setMenu}
                            temp={temp} setTemp={setTemp}
                            startTime={startTime} setStartTime={setStartTime}
                            endTime={endTime} setEndTime={setEndTime}
                            showStartPicker={showStartPicker} setShowStartPicker={setShowStartPicker}
                            showEndPicker={showEndPicker} setShowEndPicker={setShowEndPicker} 
                            bathTime={bathTime} setBathTime={setBathTime}
                            showBathPicker={showBathPicker} setShowBathPicker={setShowBathPicker}
                            onSave={saveRecordAndCloseModal}
                            onClose={() => setShowRecordModal(false)}
                        />
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
}

// 🎨 スタイル
const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#FFF8F0',
    },
    topBar: {
        padding: 12,
        backgroundColor: '#fff',
        borderBottomWidth: 1,
        borderColor: '#eee',
    },
    homeLink: {
        fontSize: 16,
        color: '#007AFF', // iOSの標準的な青色
    },
    title: {
        fontSize: 24, // 少し大きく
        fontWeight: 'bold',
        alignSelf: 'center',
        marginVertical: 10,
        color: '#333',
    },
    dateNavigation: { // 日付ナビゲーションバーのスタイル
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        marginBottom: 15,
        backgroundColor: '#f0f0f0', // 背景色を追加
        paddingVertical: 10,
        borderRadius: 8,
        marginHorizontal: 16,
    },
    dateNavButton: {
        paddingVertical: 5,
        paddingHorizontal: 10,
        backgroundColor: '#e0e0e0',
        borderRadius: 5,
    },
    dateNavButtonText: {
        fontSize: 16,
        color: '#555',
        fontWeight: 'bold',
    },
    date: {
        fontSize: 18, // 少し大きく
        alignSelf: 'center',
        color: '#555',
        fontWeight: 'bold', // 太字にしてタップ可能であることを示唆
    },
    timelineContainer: { // タイムライン全体を囲むコンテナ
        flex: 1, // 残りのスペースを占める
        paddingHorizontal: 16,
        paddingBottom: 10, // 下部バーとの重なりを避けるための余白
    },
    sectionTitle: {
        fontSize: 20, // 少し大きく
        fontWeight: 'bold',
        marginTop: 25,
        marginBottom: 15,
        color: '#444',
        borderBottomWidth: 1,
        borderColor: '#ddd',
        paddingBottom: 5,
    },
    input: {
        backgroundColor: '#fff',
        padding: 12,
        borderWidth: 1,
        borderColor: '#ccc',
        marginBottom: 10,
        borderRadius: 8,
        fontSize: 16,
        width: '100%', // 幅を100%に設定
        alignSelf: 'stretch', // 親の幅いっぱいに広がるようにする
    },
    timelineFlatList: { // タイムラインFlatList自体のスタイル
        flex: 1, // 残りのスペースを占める
        backgroundColor: '#f8f8f8', // FlatList領域の背景色
    },
    hourSlot: {
        flexDirection: 'row',
        alignItems: 'flex-start', // アイテムを時間枠の上部に揃える
        minHeight: 30, // 各時間枠の最小高さをさらに狭く
        borderBottomWidth: 1,
        borderColor: '#eee',
        paddingVertical: 5,
        backgroundColor: '#fff',
        position: 'relative', // 現在時刻ラインの絶対配置用
    },
    hourLabel: {
        fontSize: 16,
        fontWeight: 'bold',
        color: '#333',
        width: 40, // 時間ラベルの固定幅を調整
        textAlign: 'right',
        paddingRight: 10,
        marginTop: 0, // 記録の開始と揃える
    },
    recordsInHourContainer: {
        flex: 1, // 残りのスペースを占める
        paddingLeft: 10, // 時間ラベルからのスペース
    },
    timelineRecordItem: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: '#e6f7ff', // 記録の背景色を薄い青に
        borderRadius: 5,
        padding: 8,
        marginBottom: 5,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 1,
        elevation: 1,
    },
    timelineRecordMinute: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#007AFF', // 分の表示色を青に
        width: 30, // 分の固定幅
        textAlign: 'right',
        paddingRight: 5,
    },
    timelineRecordContentWrapper: {
        flex: 1,
        marginLeft: 5,
    },
    timelineRecordContent: {
        fontSize: 14,
        color: '#333',
    },
    timelineRecordNote: {
        fontSize: 12,
        color: '#666',
        marginTop: 2,
    },
    empty: {
        color: '#777',
        fontSize: 14,
        marginTop: 10,
        textAlign: 'center',
        paddingBottom: 20, // タイムラインがない場合の余白
    },
    debugButtons: {
        marginTop: 30,
        flexDirection: 'row',
        justifyContent: 'space-around',
        paddingVertical: 10,
        borderTopWidth: 1,
        borderColor: '#eee',
        paddingHorizontal: 16, 
        marginBottom: 80, // 下部バーとの重なりを避けるため
    },
    bottomBar: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingVertical: 10,
        borderTopWidth: 1,
        borderColor: '#ccc',
        backgroundColor: '#fff',
        position: 'absolute', // 画面下部に固定
        bottom: 0,
        left: 0,
        right: 0,
        height: 70, // 高さを指定して見切れを防ぐ
    },
    iconButton: {
        alignItems: 'center',
        padding: 5,
    },
    iconText: {
        fontSize: 28, // アイコンを大きく
        marginBottom: 2,
    },
    iconLabel: {
        fontSize: 12,
        color: '#555',
    },
    centeredView: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.5)', // 半透明の背景
    },
    modalView: {
        margin: 20,
        backgroundColor: 'white',
        borderRadius: 20,
        paddingHorizontal: 15, // パディングをさらに減らす
        paddingVertical: 20, // 垂直パディングは維持
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
        width: '95%', // モーダルの幅を少し広げる
        maxHeight: '80%', // モーダルの最大高さを設定
    },
    modalTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        marginBottom: 20,
        color: '#333',
    },
    // 現在時刻ラインのスタイル
    currentTimeLine: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: 2,
        backgroundColor: 'red',
        zIndex: 1, // 他の要素の上に表示
    },
});

// AmountPickerのスタイル
const amountPickerStyles = StyleSheet.create({
    container: {
        height: 150, // ピッカーの固定高さ
        width: '100%', // 幅を100%に設定
        borderWidth: 1,
        borderColor: '#ccc',
        borderRadius: 8,
        overflow: 'hidden',
        marginBottom: 10,
        backgroundColor: '#f9f9f9',
        alignSelf: 'stretch', // 親の幅いっぱいに広がるようにする
    },
    item: {
        height: 40,
        justifyContent: 'center',
        alignItems: 'center',
        borderBottomWidth: 0.5,
        borderColor: '#eee',
    },
    selectedItem: {
        backgroundColor: '#007AFF', // 選択されたアイテムの背景色
    },
    text: {
        fontSize: 18,
        color: '#333',
    },
    selectedText: {
        color: '#fff', // 選択されたテキストの色
        fontWeight: 'bold',
    },
});
