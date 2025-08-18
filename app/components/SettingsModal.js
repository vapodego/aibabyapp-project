import React from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    ScrollView,
    StyleSheet,
    Modal,
    TextInput,
    Button,
    Alert,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RadioButtonGroup from './RadioButtonGroup'; // RadioButtonGroupをインポート

const SettingsModal = ({ visible, onClose, userData, setUserData }) => {
    
    const { location, interests, userName, userAge, userGender, partnerName, partnerAge, partnerGender, childName, childAge, childGender } = userData;
    const { setLocation, setInterests, setUserName, setUserAge, setUserGender, setPartnerName, setPartnerAge, setPartnerGender, setChildName, setChildAge, setChildGender } = setUserData;

    const handleSaveSettings = async () => {
        try {
            const settings = [
                ['user_location', location], ['user_interests', interests],
                ['user_name', userName], ['user_age', userAge], ['user_gender', userGender],
                ['partner_name', partnerName], ['partner_age', partnerAge], ['partner_gender', partnerGender],
                ['child_name', childName], ['child_age', childAge], ['child_gender', childGender],
            ];
            await AsyncStorage.multiSet(settings);
            onClose();
            Alert.alert("保存しました", "プロフィール情報を更新しました。");
        } catch (e) { Alert.alert("エラー", "設定の保存に失敗しました。"); }
    };
    
    const handleInterestsChange = (text) => {
        const interestsArray = text.split(',').filter(i => i.trim() !== '');
        if (interestsArray.length > 3) {
            Alert.alert('入力制限', '興味・関心は3つまで入力できます。');
            const limitedText = interestsArray.slice(0, 3).join(',');
            setInterests(limitedText);
        } else {
            setInterests(text);
        }
    };

    return (
        <Modal visible={visible} onRequestClose={onClose} transparent={true} animationType="fade">
            <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalContainer}>
                <View style={styles.modalScrollViewContainer}>
                    <ScrollView>
                        <View style={styles.modalContent}>
                            <Text style={styles.modalTitle}>プロフィール設定</Text>
                            
                            <Text style={styles.inputLabel}>お住まいの地域 (市区町村まで)</Text>
                            <TextInput style={styles.input} value={location} onChangeText={setLocation} placeholder="例：神奈川県横浜市" />
                            
                            <Text style={styles.inputLabel}>興味・関心 (3つまで、カンマ区切り)</Text>
                            <TextInput 
                                style={styles.input} 
                                value={interests} 
                                onChangeText={handleInterestsChange} 
                                placeholder="例：動物,自然,音楽" 
                            />

                            <Text style={styles.inputLabel}>あなた</Text>
                            <View style={styles.formRow}>
                                <TextInput style={[styles.input, {flex: 2}]} value={userName} onChangeText={setUserName} placeholder="名前" />
                                <TextInput style={[styles.input, {flex: 1}]} value={userAge} onChangeText={setUserAge} placeholder="年齢" keyboardType="numeric" />
                            </View>
                            <RadioButtonGroup label="性別" options={['女性', '男性', 'その他']} selectedValue={userGender} onValueChange={setUserGender} />

                            <Text style={styles.inputLabel}>パートナー</Text>
                            <View style={styles.formRow}>
                                <TextInput style={[styles.input, {flex: 2}]} value={partnerName} onChangeText={setPartnerName} placeholder="名前" />
                                <TextInput style={[styles.input, {flex: 1}]} value={partnerAge} onChangeText={setPartnerAge} placeholder="年齢" keyboardType="numeric" />
                            </View>
                            <RadioButtonGroup label="性別" options={['女性', '男性', 'その他']} selectedValue={partnerGender} onValueChange={setPartnerGender} />

                            <Text style={styles.inputLabel}>お子様</Text>
                            <View style={styles.formRow}>
                                <TextInput style={[styles.input, {flex: 2}]} value={childName} onChangeText={setChildName} placeholder="名前" />
                                <TextInput style={[styles.input, {flex: 1}]} value={childAge} onChangeText={setChildAge} placeholder="年齢(ヶ月)" keyboardType="numeric" />
                            </View>
                            <RadioButtonGroup label="性別" options={['女の子', '男の子', 'その他']} selectedValue={childGender} onValueChange={setChildGender} />
                            
                            <View style={styles.modalButtonContainer}>
                                <Button title="キャンセル" onPress={onClose} color="#888" />
                                <Button title="保存" onPress={handleSaveSettings} />
                            </View>
                        </View>
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
};

const styles = StyleSheet.create({
    modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
    modalScrollViewContainer: { width: '90%', maxHeight: '85%', backgroundColor: 'white', borderRadius: 20 },
    modalContent: { padding: 20 },
    modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 16, textAlign: 'center' },
    inputLabel: { fontSize: 16, color: '#333', marginBottom: 8, marginTop: 8, fontWeight: 'bold' },
    input: { backgroundColor: '#f0f0f0', borderRadius: 10, padding: 12, fontSize: 16, marginBottom: 8 },
    formRow: { flexDirection: 'row', gap: 10 },
    modalButtonContainer: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 16 },
});

export default SettingsModal;
