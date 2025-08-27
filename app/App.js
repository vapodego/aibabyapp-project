// App.js (タブナビゲーション導入版)

import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import React, { useEffect, useState, useRef } from 'react';
import { Text, View, Platform, Alert, StatusBar as RNStatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// Screens
import RecordScreen from './screens/RecordScreen';
import ChatScreen from './screens/ChatScreen';
import PlanScreen from './screens/PlanScreen';
import SuggestedPlansScreen from './screens/SuggestedPlansScreen';
import DayPlanScreen from './screens/DayPlanScreen'; 
import SettingsScreen from './screens/SettingsScreen'; // ◀◀◀ 本物の設定画面をインポート
import PlanHistoryScreen from './screens/PlanHistoryScreen'; // ← 将来は専用ファイルに差し替え
import MonthlyArticleScreen from './screens/MonthlyArticleScreen';
import ArticleHubScreen from './screens/ArticleHubScreen';

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
const Tab = createBottomTabNavigator();

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

// --- タブナビゲーターを持つコンポーネントを定義 ---
function MainTabNavigator() {
  // ▼▼▼【修正点】仮の設定画面コンポーネントを削除 ▼▼▼
  /*
  const SettingsScreen = () => (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text>設定画面（準備中）</Text>
    </View>
  );
  */
  // ▲▲▲ ここまで ▲▲▲

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
          } else if (route.name === 'SuggestedTab') {
            iconName = focused ? 'star' : 'star-outline';
          } else if (route.name === 'ArticleHub') {
            iconName = focused ? 'book' : 'book-outline';
          } else if (route.name === 'SettingsTab') {
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
      <Tab.Screen name="SuggestedTab" component={SuggestedPlansScreen} options={{ title: '提案' }} />
      <Tab.Screen name="ArticleHub" component={ArticleHubScreen} options={{ title: '月齢記事' }} />
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
      // まだ未ログインなら匿名サインインして Firestore ルールを満たす
      if (!auth.currentUser) {
        signInAnonymously(auth).catch((e) => console.warn('[App] anonymous sign-in failed:', e));
      }
    }, []);
 
    useEffect(() => {
    if (Platform.OS === 'android') {
      RNStatusBar.setBackgroundColor('#000000', true);
      RNStatusBar.setBarStyle('light-content', true);
      RNStatusBar.setTranslucent(false);
    }
  }, []);

    useEffect(() => {
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

    return (
        <SafeAreaProvider>
        <NavigationContainer>
            <Stack.Navigator
              screenOptions={{
                 statusBarColor: '#000000',
                 statusBarStyle: 'light',
                 statusBarTranslucent: false,
               }}
            >
                <Stack.Screen 
                  name="Main" 
                  component={MainTabNavigator} 
                  options={{ headerShown: false }} 
                />
                
                <Stack.Screen name="Plan" component={PlanScreen} options={{ headerShown: false }} />
                <Stack.Screen name="SuggestedPlans" component={SuggestedPlansScreen} options={{ headerShown: false }} />
                <Stack.Screen name="DayPlan" component={DayPlanScreen} options={{ headerShown: false }} />
                <Stack.Screen name="PlanHistory" component={PlanHistoryScreen} options={{ headerShown: false }} />
                <Stack.Screen name="MonthlyArticle" component={MonthlyArticleScreen} options={{ headerShown: false }} />
            </Stack.Navigator>
        </NavigationContainer>
         </SafeAreaProvider>
    );
}
