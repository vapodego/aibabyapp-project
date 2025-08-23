import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const FooterNav = ({ navigation, onSettingsPress }) => {
    const insets = useSafeAreaInsets();
    const state = navigation?.getState?.();
    const currentRoute = state?.routes?.[state?.index || 0]?.name;

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
                onPress={() => navigation.navigate('Chat')}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive('Chat') }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                activeOpacity={0.7}
            >
                <Ionicons name={isActive('Chat') ? 'home' : 'home-outline'} size={24} color={isActive('Chat') ? activeColor : inactiveColor} />
                <Text style={[styles.navText, { color: isActive('Chat') ? activeColor : inactiveColor }]}>ホーム</Text>
            </TouchableOpacity>

            {/* 記録 */}
            <TouchableOpacity
                style={styles.navButton}
                onPress={() => navigation.navigate('Record')}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive('Record') }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                activeOpacity={0.7}
            >
                <Ionicons name={isActive('Record') ? 'create' : 'create-outline'} size={24} color={isActive('Record') ? activeColor : inactiveColor} />
                <Text style={[styles.navText, { color: isActive('Record') ? activeColor : inactiveColor }]}>記録する</Text>
            </TouchableOpacity>

            {/* 履歴 */}
            <TouchableOpacity
                style={styles.navButton}
                onPress={() => navigation.navigate('PlanHistory')}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive('PlanHistory') }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                activeOpacity={0.7}
            >
                <Ionicons name={isActive('PlanHistory') ? 'time' : 'time-outline'} size={24} color={isActive('PlanHistory') ? activeColor : inactiveColor} />
                <Text style={[styles.navText, { color: isActive('PlanHistory') ? activeColor : inactiveColor }]}>履歴</Text>
            </TouchableOpacity>

            {/* 設定 */}
            <TouchableOpacity
                style={styles.navButton}
                onPress={onSettingsPress || (() => navigation.navigate('Settings'))}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive('Settings') }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                activeOpacity={0.7}
            >
                <Ionicons name={isActive('Settings') ? 'settings' : 'settings-outline'} size={24} color={isActive('Settings') ? activeColor : inactiveColor} />
                <Text style={[styles.navText, { color: isActive('Settings') ? activeColor : inactiveColor }]}>設定</Text>
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
