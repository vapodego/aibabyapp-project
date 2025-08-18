import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, TextInput, Button, Alert, Platform, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import RadioButtonGroup from '../components/RadioButtonGroup';

// --- ヘルパー関数 ---
const calculateAge = (dobString) => {
    if (!dobString) return '';
    const dob = new Date(dobString);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
        age--;
    }
    return age > 0 ? `${age}歳` : '';
};

const calculateMonths = (dobString) => {
    if (!dobString) return '';
    const dob = new Date(dobString);
    const today = new Date();
    let months;
    months = (today.getFullYear() - dob.getFullYear()) * 12;
    months -= dob.getMonth();
    months += today.getMonth();
    return months <= 0 ? '0ヶ月' : `${months}ヶ月`;
};

const formatDate = (date) => {
    if (!date) return '未設定';
    const d = new Date(date);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};


const SettingsScreen = ({ navigation }) => {
    // --- State管理 ---
    const [location, setLocation] = useState('');
    const [userName, setUserName] = useState('');
    const [userGender, setUserGender] = useState('');
    const [partnerName, setPartnerName] = useState('');
    const [partnerGender, setPartnerGender] = useState('');
    const [childName, setChildName] = useState('');
    const [childGender, setChildGender] = useState('');
    
    // 年齢をDOB(Date of Birth)に変更
    const [userDOB, setUserDOB] = useState(null);
    const [partnerDOB, setPartnerDOB] = useState(null);
    const [childDOB, setChildDOB] = useState(null);

    // DatePicker用のState
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [datePickerFor, setDatePickerFor] = useState(null); // 'user', 'partner', 'child'

    // --- データ読み込み ---
    useEffect(() => {
        const loadInitialData = async () => {
            try {
                const keys = ['user_location', 'user_name', 'user_dob', 'user_gender', 'partner_name', 'partner_dob', 'partner_gender', 'child_name', 'child_dob', 'child_gender'];
                const settings = await AsyncStorage.multiGet(keys);
                const settingsObj = Object.fromEntries(settings);
                setLocation(settingsObj.user_location || '');
                setUserName(settingsObj.user_name || '');
                setUserDOB(settingsObj.user_dob ? new Date(settingsObj.user_dob) : null);
                setUserGender(settingsObj.user_gender || '');
                setPartnerName(settingsObj.partner_name || '');
                setPartnerDOB(settingsObj.partner_dob ? new Date(settingsObj.partner_dob) : null);
                setPartnerGender(settingsObj.partner_gender || '');
                setChildName(settingsObj.child_name || '');
                setChildDOB(settingsObj.child_dob ? new Date(settingsObj.child_dob) : null);
                setChildGender(settingsObj.child_gender || '');
            } catch (e) {
                Alert.alert("エラー", "設定の読み込みに失敗しました。");
            }
        };
        loadInitialData();
    }, []);

    // --- イベントハンドラ ---
    const handleSaveSettings = async () => {
        try {
            const settings = [
                ['user_location', location],
                ['user_name', userName], ['user_dob', userDOB ? userDOB.toISOString() : ''], ['user_gender', userGender],
                ['partner_name', partnerName], ['partner_dob', partnerDOB ? partnerDOB.toISOString() : ''], ['partner_gender', partnerGender],
                ['child_name', childName], ['child_dob', childDOB ? childDOB.toISOString() : ''], ['child_gender', childGender],
            ];
            await AsyncStorage.multiSet(settings);
            Alert.alert("保存しました", "プロフィール情報を更新しました。", [
                { text: "OK", onPress: () => navigation.goBack() }
            ]);
        } catch (e) { Alert.alert("エラー", "設定の保存に失敗しました。"); }
    };

    const openDatePicker = (target) => {
        setDatePickerFor(target);
        setShowDatePicker(true);
    };

    const onDateChange = (event, selectedDate) => {
        setShowDatePicker(Platform.OS === 'ios'); // iOSでは手動で閉じる
        if (selectedDate) {
            switch (datePickerFor) {
                case 'user': setUserDOB(selectedDate); break;
                case 'partner': setPartnerDOB(selectedDate); break;
                case 'child': setChildDOB(selectedDate); break;
            }
        }
    };
    
    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>プロフィール設定</Text>
            </View>
            <ScrollView contentContainerStyle={styles.scrollContent}>
                <View style={styles.formSection}>
                    <Text style={styles.inputLabel}>住所</Text>
                    <TextInput style={styles.input} value={location} onChangeText={setLocation} placeholder="例：神奈川県横浜市" placeholderTextColor="#AAAAAA" />
                    
                    <Text style={styles.inputLabel}>あなた</Text>
                    <View style={styles.formRow}>
                        <TextInput style={[styles.input, {flex: 2}]} value={userName} onChangeText={setUserName} placeholder="名前 (例: 陽菜)" placeholderTextColor="#AAAAAA" />
                        <TouchableOpacity style={[styles.input, styles.dateInput, {flex: 1}]} onPress={() => openDatePicker('user')}>
                            <Text style={styles.dateText}>{userDOB ? `${formatDate(userDOB)} (${calculateAge(userDOB)})` : '生年月日'}</Text>
                        </TouchableOpacity>
                    </View>
                    <RadioButtonGroup label="性別" options={['女性', '男性', 'その他']} selectedValue={userGender} onValueChange={setUserGender} />

                    <Text style={styles.inputLabel}>パートナー</Text>
                    <View style={styles.formRow}>
                        <TextInput style={[styles.input, {flex: 2}]} value={partnerName} onChangeText={setPartnerName} placeholder="名前 (例: 蒼甫)" placeholderTextColor="#AAAAAA" />
                        <TouchableOpacity style={[styles.input, styles.dateInput, {flex: 1}]} onPress={() => openDatePicker('partner')}>
                            <Text style={styles.dateText}>{partnerDOB ? `${formatDate(partnerDOB)} (${calculateAge(partnerDOB)})` : '生年月日'}</Text>
                        </TouchableOpacity>
                    </View>
                    <RadioButtonGroup label="性別" options={['女性', '男性', 'その他']} selectedValue={partnerGender} onValueChange={setPartnerGender} />

                    <Text style={styles.inputLabel}>お子様</Text>
                    <View style={styles.formRow}>
                        <TextInput style={[styles.input, {flex: 2}]} value={childName} onChangeText={setChildName} placeholder="名前 (例: 結月)" placeholderTextColor="#AAAAAA" />
                        <TouchableOpacity style={[styles.input, styles.dateInput, {flex: 1}]} onPress={() => openDatePicker('child')}>
                             <Text style={styles.dateText}>{childDOB ? `${formatDate(childDOB)} (${calculateMonths(childDOB)})` : '生年月日'}</Text>
                        </TouchableOpacity>
                    </View>
                    <RadioButtonGroup label="性別" options={['女の子', '男の子', 'その他']} selectedValue={childGender} onValueChange={setChildGender} />
                    
                    <View style={styles.buttonContainer}>
                        <Button title="保存する" onPress={handleSaveSettings} />
                    </View>
                </View>
            </ScrollView>

            {showDatePicker && (
                <DateTimePicker
                    value={
                        (datePickerFor === 'user' && userDOB) ||
                        (datePickerFor === 'partner' && partnerDOB) ||
                        (datePickerFor === 'child' && childDOB) ||
                        new Date()
                    }
                    mode="date"
                    display="spinner" // iOS/Androidで見やすいスピナー形式に統一
                    onChange={onDateChange}
                    maximumDate={new Date()} // 未来の日付は選択不可に
                />
            )}
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F8F9FA' },
    header: { paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#E9ECEF', alignItems: 'center', backgroundColor: 'white' },
    headerTitle: { fontSize: 18, fontWeight: 'bold' },
    scrollContent: { paddingBottom: 40 },
    formSection: { padding: 20 },
    inputLabel: { fontSize: 16, color: '#343A40', marginBottom: 8, marginTop: 16, fontWeight: '600' },
    input: { backgroundColor: 'white', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12, fontSize: 16, borderWidth: 1, borderColor: '#CED4DA' },
    formRow: { flexDirection: 'row', gap: 10 },
    buttonContainer: { marginTop: 32 },
    dateInput: {
        justifyContent: 'center',
        alignItems: 'center',
    },
    dateText: {
        fontSize: 14, // 年齢も表示するため少し小さく
        color: '#343A40'
    }
});

export default SettingsScreen;
