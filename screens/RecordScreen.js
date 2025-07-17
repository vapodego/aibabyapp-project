import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TextInput,
    Button,
    FlatList,
    Alert,
    Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import DateTimePicker from '@react-native-community/datetimepicker';
import { v4 as uuidv4 } from 'uuid';
import { InteractionManager } from 'react-native';

export default function RecordScreen({ navigation }) {
    const [recordType, setRecordType] = useState('ミルク');
    const [amount, setAmount] = useState('');
    const [note, setNote] = useState('');
    const [style, setStyle] = useState('');
    const [menu, setMenu] = useState('');
    const [temp, setTemp] = useState('');
    const [startTime, setStartTime] = useState(new Date());
    const [endTime, setEndTime] = useState(new Date());
    const [showStartPicker, setShowStartPicker] = useState(false);
    const [showEndPicker, setShowEndPicker] = useState(false);
    const [bathTime, setBathTime] = useState(new Date());
    const [showBathPicker, setShowBathPicker] = useState(false);
    const [records, setRecords] = useState([]);
    const [appReady, setAppReady] = useState(false);

    const saveRecord = async () => {
        console.log('🐛 saveRecord が呼ばれました');
        console.log('📋 recordType:', recordType);
        console.log('📥 入力値:', { amount, note, style, temp, menu });

        let data = {};

        switch (recordType) {
            case 'ミルク':
                if (!amount.trim()) {
                    Alert.alert('エラー', '量（ml）を入力してください');
                    return;
                }
                data = { amount, note };
                break;
            case '排泄':
                if (!style.trim()) {
                    Alert.alert('エラー', '排泄スタイルを入力してください');
                    return;
                }
                data = { style, note };
                break;
            case '睡眠':
                data = { start: startTime.toLocaleString(), end: endTime.toLocaleString(), note };
                break;
            case '離乳食':
                if (!menu.trim() || !amount.trim()) {
                    Alert.alert('エラー', '食べたものと量を入力してください');
                    return;
                }
                data = { menu, amount, note };
                break;
            case '体温':
                if (!temp.trim()) {
                    Alert.alert('エラー', '体温を入力してください');
                    return;
                }
                data = { temp, note };
                break;
            case '入浴':
                data = { time: bathTime.toLocaleString(), note };
                break;
            default:
                Alert.alert('不明な記録タイプ');
                return;
        }

        const newRecord = {
            id: uuidv4(),
            type: recordType,
            time: new Date().toLocaleString(),
            data,
        };

        const updated = [newRecord, ...records];
        console.log('🧪 保存対象データ(JSON):', JSON.stringify(updated));
        setRecords(updated);

        try {
            await AsyncStorage.setItem('records', JSON.stringify(updated));
            console.log('✅ setItem 成功');
            // 保存直後に再取得して確認（Android検証用）
            setTimeout(async () => {
                const reloaded = await AsyncStorage.getItem('records');
                console.log('🧪 setTimeoutで再取得:', reloaded);
            }, 1000); // 1秒遅延で確認

            const verify = await AsyncStorage.getItem('records');
            console.log('🧪 保存直後の再取得:', verify);

            await loadRecords();
            Alert.alert('保存しました', `${recordType}の記録を保存しました！`);
            try {
                await AsyncStorage.setItem('testKey', JSON.stringify({ hello: 'android' }));
                const verify = await AsyncStorage.getItem('testKey');
                console.log('🧪 testKey確認（Android）:', verify);
            } catch (e) {
                console.error('❌ testKey保存失敗:', e);
            }

            // この後、入力値初期化してOK
            setAmount('');
            setNote('');
            setStyle('');
            setMenu('');
            setTemp('');
        } catch (err) {
            console.error('❌ AsyncStorage 保存失敗:', err);
            Alert.alert('保存失敗', 'データの保存に失敗しました');
        }

        setAmount(''); setNote(''); setStyle(''); setMenu(''); setTemp('');
    };
    const testAsyncStorage = async () => {
        const dummy = [{ id: '1', type: 'ミルク', time: new Date().toLocaleString(), data: { amount: 100, note: 'test' } }];
        try {
            await AsyncStorage.setItem('records', JSON.stringify(dummy));
            const result = await AsyncStorage.getItem('records');
            console.log('🧪 手動保存確認:', result);
        } catch (e) {
            console.error('❌ 手動保存失敗:', e);
        }
    };
    const loadRecords = async () => {
        try {
            const data = await AsyncStorage.getItem('records');
            console.log("🧪 AsyncStorageから取得したdata:", data);
            const parsed = JSON.parse(data) || [];
            const cleaned = parsed.filter(item => item && typeof item === 'object');
            const normalized = cleaned.map(item => {
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
            console.log("🧪 正規化されたrecords:", normalized);
            setRecords(normalized);
        } catch (err) {
            console.error('❌ AsyncStorage 保存失敗:', err);
            Alert.alert('保存失敗', 'データの保存に失敗しました');
        }
    };

    const renderInputFields = () => {
        switch (recordType) {
            case 'ミルク':
                return (<>
                    <TextInput placeholder="量（ml）" value={amount} onChangeText={setAmount} keyboardType="numeric" style={styles.input} />
                    <TextInput placeholder="メモ" value={note} onChangeText={setNote} style={styles.input} />
                </>);
            case '排泄':
                return (<>
                    <TextInput placeholder="スタイル（うんち／おしっこ）" value={style} onChangeText={setStyle} style={styles.input} />
                    <TextInput placeholder="メモ" value={note} onChangeText={setNote} style={styles.input} />
                </>);
            case '睡眠':
                return (<>
                    <Button title={`開始: ${startTime.toLocaleTimeString()}`} onPress={() => setShowStartPicker(true)} />
                    {showStartPicker && <DateTimePicker value={startTime} mode="time" is24Hour display="default" onChange={(e, date) => { setShowStartPicker(Platform.OS === 'ios'); if (date) setStartTime(date); }} />}
                    <Button title={`終了: ${endTime.toLocaleTimeString()}`} onPress={() => setShowEndPicker(true)} />
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
                    <Button title={`入浴時刻: ${bathTime.toLocaleTimeString()}`} onPress={() => setShowBathPicker(true)} />
                    {showBathPicker && <DateTimePicker value={bathTime} mode="time" is24Hour display="default" onChange={(e, date) => { setShowBathPicker(Platform.OS === 'ios'); if (date) setBathTime(date); }} />}
                    <TextInput placeholder="メモ" value={note} onChangeText={setNote} style={styles.input} />
                </>);
            default:
                return null;
        }
    };

    useEffect(() => {
        loadRecords();
    }, []);
    useEffect(() => {
        const testSave = async () => {
            try {
                await AsyncStorage.setItem('testSave', JSON.stringify({ hello: 'android!' }));
                const result = await AsyncStorage.getItem('testSave');
                console.log('🧪 testSave 保存 → 取得:', result);
            } catch (e) {
                console.error('❌ testSave 保存失敗:', e);
            }
        };
        testSave();
    }, []);
    useEffect(() => {
        InteractionManager.runAfterInteractions(() => {
            setAppReady(true);
        });
    }, []);

    if (!appReady) {
        return (
            <View style={styles.container}>
                <Text>⏳ 準備中...</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <Text style={styles.header}>📋 記録入力</Text>
            <Picker selectedValue={recordType} onValueChange={setRecordType}>
                <Picker.Item label="🍼 ミルク" value="ミルク" />
                <Picker.Item label="🚽 排泄" value="排泄" />
                <Picker.Item label="💤 睡眠" value="睡眠" />
                <Picker.Item label="🍚 離乳食" value="離乳食" />
                <Picker.Item label="🌡 体温" value="体温" />
                <Picker.Item label="🛁 入浴" value="入浴" />
            </Picker>
            {renderInputFields()}
            <Button title="記録する" onPress={saveRecord} />
            <View style={[styles.list, { flex: 1 }]}>
                <Text style={styles.subHeader}>🗂 記録一覧</Text>
                {records.length === 0 ? (
                    <Text style={styles.empty}>📌 記録がまだありません</Text>
                ) : (
                    <FlatList
                        style={{ flexGrow: 1 }}
                        data={records}
                        keyExtractor={(item, index) => item?.id || index.toString()}
                        renderItem={({ item }) => {
                            const recordData = item.data || {};
                            return (
                                <View style={styles.item}>
                                    <Text>
                                        🕒 {item.time} - 🏷 {item.type}{' '}
                                        {recordData.amount && `📦 ${recordData.amount}`}
                                        {recordData.style && `🚽 ${recordData.style}`}
                                        {recordData.menu && `🍽 ${recordData.menu}`}
                                        {recordData.temp && `🌡 ${recordData.temp}`}
                                        {recordData.start && recordData.end && `💤 ${recordData.start}〜${recordData.end}`}
                                        {recordData.time && `🛁 ${recordData.time}`}
                                    </Text>
                                    {recordData.note ? <Text style={styles.note}>📝 {recordData.note}</Text> : null}
                                </View>
                            );
                        }}
                    />
                )}
            </View>
            <View style={styles.chatButton}>
                <Button title="まな先生とお話しする" onPress={() => navigation.navigate('Chat')} color="#007AFF" />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, padding: 16, backgroundColor: '#fff8f0' },
    header: { fontSize: 20, marginBottom: 12 },
    subHeader: { fontSize: 16, marginTop: 20, marginBottom: 8 },
    input: {
        backgroundColor: '#fff',
        padding: 10,
        borderWidth: 1,
        borderColor: '#ccc',
        marginBottom: 8,
        borderRadius: 6,
    },
    list: { marginTop: 16 },
    item: {
        padding: 10,
        borderBottomWidth: 1,
        borderColor: '#ddd',
    },
    note: { color: '#555', fontSize: 12 },
    empty: { color: '#777', fontSize: 14, marginTop: 10 },
    chatButton: { marginTop: 16 },
});
