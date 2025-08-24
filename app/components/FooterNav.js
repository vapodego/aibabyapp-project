import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const FooterNav = ({ navigation, onSettingsPress }) => {
    const insets = useSafeAreaInsets();
    const state = navigation?.getState?.();
    const currentRoute = state?.routes?.[state?.index || 0]?.name;

    // Tab Navigator のスクリーン名と合わせる（App.js: HomeTab / RecordTab / SuggestedTab / SettingsTab）
    const isActive = (name) => currentRoute === name;
    const activeColor = '#FF6347';
    const inactiveColor = '#888';

    return (
        <View
            style={[
                styles.footerNav,
                {
                    paddingBottom: insets.bottom || 10,
                    height: (Platform.OS === 'ios' ? 60 : 56) + (insets.bottom || 0),
                },
            ]}
            accessibilityRole="tablist"
        >
            {/* ホーム */}
            <TouchableOpacity
                style={styles.navButton}
                onPress={() => navigation.navigate('HomeTab')}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive('HomeTab') }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                activeOpacity={0.7}
            >
                <Ionicons name={isActive('HomeTab') ? 'home' : 'home-outline'} size={24} color={isActive('HomeTab') ? activeColor : inactiveColor} />
                <Text style={[styles.navText, { color: isActive('HomeTab') ? activeColor : inactiveColor }]}>ホーム</Text>
            </TouchableOpacity>

            {/* 記録 */}
            <TouchableOpacity
                style={styles.navButton}
                onPress={() => navigation.navigate('RecordTab')}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive('RecordTab') }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                activeOpacity={0.7}
            >
                <Ionicons name={isActive('RecordTab') ? 'create' : 'create-outline'} size={24} color={isActive('RecordTab') ? activeColor : inactiveColor} />
                <Text style={[styles.navText, { color: isActive('RecordTab') ? activeColor : inactiveColor }]}>記録する</Text>
            </TouchableOpacity>

            {/* 提案 */}
            <TouchableOpacity
                style={styles.navButton}
                onPress={() => navigation.navigate('SuggestedTab')}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive('SuggestedTab') }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                activeOpacity={0.7}
            >
                <Ionicons name={isActive('SuggestedTab') ? 'star' : 'star-outline'} size={24} color={isActive('SuggestedTab') ? activeColor : inactiveColor} />
                <Text style={[styles.navText, { color: isActive('SuggestedTab') ? activeColor : inactiveColor }]}>提案</Text>
            </TouchableOpacity>

            {/* 設定 */}
            <TouchableOpacity
                style={styles.navButton}
                onPress={onSettingsPress || (() => navigation.navigate('SettingsTab'))}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive('SettingsTab') }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                activeOpacity={0.7}
            >
                <Ionicons name={isActive('SettingsTab') ? 'settings' : 'settings-outline'} size={24} color={isActive('SettingsTab') ? activeColor : inactiveColor} />
                <Text style={[styles.navText, { color: isActive('SettingsTab') ? activeColor : inactiveColor }]}>設定</Text>
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
        paddingTop: 6,
        // height and paddingBottom are set dynamically with safe area insets
    },
    navButton: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
    },
    navText: {
        fontSize: 11,
        color: '#888',
    },
});

export default FooterNav;
