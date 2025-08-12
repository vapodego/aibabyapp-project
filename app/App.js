// App.js (タブナビゲーション導入版)

import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'; // ◀◀◀ 追加
import React, { useEffect, useState, useRef } from 'react';
import { Text, View, Platform, Alert, StatusBar as RNStatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// Screens
import RecordScreen from './screens/RecordScreen';
import ChatScreen from './screens/ChatScreen';
import PlanScreen from './screens/PlanScreen';
import SuggestedPlansScreen from './screens/SuggestedPlansScreen';
import DayPlanScreen from './screens/DayPlanScreen'; 

// Utilities & Firebase
import { loadInitialRecords } from './utils/loadInitialRecords';
import { initializeApp } from 'firebase/app';
import { initializeAuth, getReactNativePersistence, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';
import { getFirestore, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { API_KEY, AUTH_DOMAIN, PROJECT_ID, STORAGE_BUCKET, MESSAGING_SENDER_ID, APP_ID, MEASUREMENT_ID } from '@env';

// --- Navigatorのインスタンスを作成 ---
const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator(); // ◀◀◀ タブ用のインスタンスを追加

// --- Firebase Config (変更なし) ---
const firebaseConfig = {
    apiKey: API_KEY, authDomain: AUTH_DOMAIN, projectId: PROJECT_ID,
    storageBucket: STORAGE_BUCKET, messagingSenderId: MESSAGING_SENDER_ID,
    appId: APP_ID, measurementId: MEASUREMENT_ID
};
const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, { persistence: getReactNativePersistence(ReactNativeAsyncStorage) });
const db = getFirestore(app);

// --- Notification Handler (変更なし) ---
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false,
    }),
});

// --- Push Token Helper Function (変更なし) ---
async function registerForPushNotificationsAsync() { /* ... */ }

// ▼▼▼【ここからが大きな変更点】▼▼▼

// --- タブナビゲーターを持つコンポーネントを定義 ---
function MainTabNavigator() {
  // 仮の設定画面コンポーネント
  const SettingsScreen = () => (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text>設定画面（準備中）</Text>
    </View>
  );

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ focused, color, size }) => {
          let iconName;
          if (route.name === 'HomeTab') {
            iconName = focused ? 'home' : 'home-outline';
          } else if (route.name === 'RecordTab') {
            iconName = focused ? 'calendar' : 'calendar-outline';
          } else if (route.name === 'SettingsTab') { // ◀◀◀ 追加
            iconName = focused ? 'settings' : 'settings-outline';
          }
          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: '#6C63FF',
        tabBarInactiveTintColor: 'gray',
        tabBarStyle: {
            paddingBottom: Platform.OS === 'ios' ? 20 : 5,
            height: 75,
        }
      })}
    >
      <Tab.Screen name="HomeTab" component={ChatScreen} options={{ title: 'ホーム' }} />
      <Tab.Screen name="RecordTab" component={RecordScreen} options={{ title: '記録' }} />
      <Tab.Screen name="SettingsTab" component={SettingsScreen} options={{ title: '設定' }} />
    </Tab.Navigator>
  );
}

// --- Main App Component ---
export default function App() {
    const [userId, setUserId] = useState(null);
    const notificationListener = useRef();
    const responseListener = useRef();
 
    useEffect(() => {
    if (Platform.OS === 'android') {
      // 背景を黒、アイコンを白に強制（Expo Goでも確実に効く）
      RNStatusBar.setBackgroundColor('#000000', true);
      RNStatusBar.setBarStyle('light-content', true);
      RNStatusBar.setTranslucent(false);
    }
  }, []);

    useEffect(() => {
        // ... (この中のロジックは変更なし)
        loadInitialRecords();
        const initializeAppAndGetToken = async (user) => { /* ... */ };
        const unsubscribe = onAuthStateChanged(auth, initializeAppAndGetToken);
        notificationListener.current = Notifications.addNotificationReceivedListener(notification => {});
        responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {});
        return () => {
            unsubscribe();
            if (notificationListener.current) { Notifications.removeNotificationSubscription(notificationListener.current); }
            if (responseListener.current) { Notifications.removeNotificationSubscription(responseListener.current); }
        };
    }, []);

    // --- アプリ全体のナビゲーション構造を修正 ---
    return (
        <SafeAreaProvider>
        <NavigationContainer>
            <Stack.Navigator
  screenOptions={{
     statusBarColor: '#000000',      // Androidのバー背景
     statusBarStyle: 'light',        // アイコンを白
     statusBarTranslucent: false,    // 下に潜らせない
   }}
 >
                {/* メイン画面としてタブナビゲーターを配置 */}
                <Stack.Screen 
                  name="Main" 
                  component={MainTabNavigator} 
                  options={{ headerShown: false }} 
                />
                
                {/* タブの上に重ねて表示する画面 */}
                <Stack.Screen name="Plan" component={PlanScreen} options={{ headerShown: false }} />
                <Stack.Screen name="SuggestedPlans" component={SuggestedPlansScreen} options={{ headerShown: false }} />
                <Stack.Screen name="DayPlan" component={DayPlanScreen} options={{ headerShown: false }} />
            </Stack.Navigator>
        </NavigationContainer>
         </SafeAreaProvider>
    );
}