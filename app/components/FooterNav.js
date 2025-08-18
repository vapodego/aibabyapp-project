import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const FooterNav = ({ navigation, onSettingsPress }) => {
    return (
        <View style={styles.footerNav}>
            <TouchableOpacity style={styles.navButton} onPress={() => {}}>
                <Ionicons name="home" size={26} color="#FF6347" />
                <Text style={[styles.navText, {color: '#FF6347'}]}>ホーム</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.navButton} onPress={() => navigation.navigate('Record')}>
                <Ionicons name="create-outline" size={26} color="#888" />
                <Text style={styles.navText}>記録する</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.navButton} onPress={onSettingsPress}>
                <Ionicons name="settings-outline" size={26} color="#888" />
                <Text style={styles.navText}>設定</Text>
            </TouchableOpacity>
        </View>
    );
};

const styles = StyleSheet.create({
    footerNav: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        flexDirection: 'row',
        backgroundColor: 'white',
        borderTopWidth: 1,
        borderTopColor: '#E0E0E0',
        // ▼▼▼【修正点】高さを固定し、paddingで中身を調整 ▼▼▼
        height: Platform.OS === 'ios' ? 90 : 70, 
        paddingTop: 10,
        paddingBottom: Platform.OS === 'ios' ? 30 : 10,
    },
    navButton: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center', // 垂直方向の中央揃え
    },
    navText: {
        fontSize: 11,
        color: '#888',
        marginTop: 2,
    },
});

export default FooterNav;
