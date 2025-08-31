// App.js (タブナビゲーション導入版)

import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Text, View, Platform, Alert, StatusBar as RNStatusBar, Animated, Easing } from 'react-native';
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
import { getFirestore, doc, setDoc, serverTimestamp, collection, query, where, onSnapshot, orderBy, limit } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { API_KEY, AUTH_DOMAIN, PROJECT_ID, STORAGE_BUCKET, MESSAGING_SENDER_ID, APP_ID, MEASUREMENT_ID } from '@env';
import { PULSE_POLICY, SUGGESTED_UNREAD_BY_FLAG } from './config/featureFlags';

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
  const [unreadArticles, setUnreadArticles] = useState(0);
  const [unreadSuggested, setUnreadSuggested] = useState(0);
  const [uid, setUid] = useState(auth.currentUser?.uid || null);
  const [suggestedLastOpened, setSuggestedLastOpened] = useState(null);
  const [isPlanGenerating, setIsPlanGenerating] = useState(false);
  const [latestRunId, setLatestRunId] = useState(null);

  // Track auth and subscribe to unread article feeds
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, (u) => setUid(u?.uid || null));
    return () => unsubAuth();
  }, []);

  useEffect(() => {
    if (!uid) { setUnreadArticles(0); return; }
    const feedsCol = collection(db, 'users', uid, 'articleFeeds');
    const q = query(feedsCol, where('readAt', '==', null));
    const unsub = onSnapshot(q, (snap) => {
      setUnreadArticles(snap.size || 0);
    }, (err) => {
      console.warn('[MainTab] unread feeds subscribe failed:', err?.message || err);
      setUnreadArticles(0);
    });
    return () => unsub();
  }, [uid]);

  // Suggested: track last opened and latest run
  useEffect(() => {
    if (!uid) { setSuggestedLastOpened(null); setIsPlanGenerating(false); return; }
    const unsub = onSnapshot(doc(db, 'users', uid), (snap) => {
      const data = snap.data() || {};
      setSuggestedLastOpened(data.suggestedLastOpenedAt || null);
      setIsPlanGenerating(String(data.planGenerationStatus || '') === 'in_progress');
    }, () => { setSuggestedLastOpened(null); setIsPlanGenerating(false); });
    return () => unsub();
  }, [uid]);
  useEffect(() => {
    if (!uid) { setLatestRunId(null); return; }
    const runsQ = query(collection(db, 'users', uid, 'planRuns'), orderBy('createdAt', 'desc'), limit(1));
    const unsub = onSnapshot(runsQ, (snap) => {
      const id = snap.docs[0]?.id || null;
      setLatestRunId(id);
    }, () => setLatestRunId(null));
    return () => unsub();
  }, [uid]);
  useEffect(() => {
    if (!uid || !latestRunId) { setUnreadSuggested(0); return; }
    const plansQ = query(
      collection(db, 'users', uid, 'planRuns', latestRunId, 'suggestedPlans'),
      orderBy('createdAt', 'desc')
    );
    const unsub = onSnapshot(plansQ, (snap) => {
      try {
        if (!snap) { setUnreadSuggested(0); return; }
        if (SUGGESTED_UNREAD_BY_FLAG) {
          let cnt = 0;
          snap.docs.forEach(d => { const rd = d.data(); if (!rd || rd.placeholder) return; if (!rd.readAt) cnt += 1; });
          setUnreadSuggested(cnt);
          return;
        }
        // timestamp-based fallback (since last opened)
        const last = suggestedLastOpened;
        if (!last) { setUnreadSuggested(snap.size || 0); return; }
        const lastMs = last?.toMillis ? last.toMillis() : (last?.seconds ? last.seconds * 1000 : Date.parse(last) || 0);
        let count = 0;
        snap.docs.forEach(d => {
          const c = d.data()?.createdAt;
          const ms = c?.toMillis ? c.toMillis() : (c?.seconds ? c.seconds * 1000 : Date.parse(c) || 0);
          if (!lastMs || (ms && ms > lastMs)) count += 1;
        });
        setUnreadSuggested(count);
      } catch (_) { setUnreadSuggested(0); }
    }, () => setUnreadSuggested(0));
    return () => unsub();
  }, [uid, latestRunId, suggestedLastOpened]);

  // OS app icon badge count (sum of unread counts)
  useEffect(() => {
    const total = (unreadArticles || 0) + (unreadSuggested || 0);
    Notifications.setBadgeCountAsync(total).catch(() => {});
  }, [unreadArticles, unreadSuggested]);

  // One-time (policy-based) mini pulse animation per tab when unread > 0
  const useOneTimePulseValue = (baseKey, trigger, policy) => {
    const scale = useRef(new Animated.Value(1)).current;
    const computeStorageKey = () => {
      const p = policy || { type: 'once' };
      if (p.type === 'daily') {
        const d = new Date();
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${baseKey}:daily:${yyyy}-${mm}-${dd}`;
      }
      if (p.type === 'version') {
        const v = String(p.version || 'v1');
        return `${baseKey}:ver:${v}`;
      }
      return `${baseKey}:once`;
    };
    useEffect(() => {
      let canceled = false;
      (async () => {
        try {
          if (!trigger) return;
          const storageKey = computeStorageKey();
          const done = await AsyncStorage.getItem(storageKey);
          if (done) return;
          if (canceled) return;
          await new Promise(r => setTimeout(r, 100));
          Animated.sequence([
            Animated.timing(scale, { toValue: 1.18, duration: 360, easing: Easing.out(Easing.quad), useNativeDriver: true }),
            Animated.timing(scale, { toValue: 1.0, duration: 320, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          ]).start(() => { const k = computeStorageKey(); AsyncStorage.setItem(k, '1').catch(() => {}); });
        } catch (_) {}
      })();
      return () => { canceled = true; };
    }, [baseKey, trigger, policy]);
    return scale;
  };
  const articleScale = useOneTimePulseValue('pulse_tab_article', unreadArticles > 0, PULSE_POLICY.article);
  const suggestedScale = useOneTimePulseValue('pulse_tab_suggested', unreadSuggested > 0, PULSE_POLICY.suggested);
  // ▼▼▼【修正点】仮の設定画面コンポーネントを削除 ▼▼▼
  /*
  const SettingsScreen = () => (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text>設定画面（準備中）</Text>
    </View>
  );
  */
  // ▲▲▲ ここまで ▲▲▲

  const renderIcon = useCallback((route, focused, color, size) => {
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
    const scaleVal = route.name === 'ArticleHub' ? articleScale : (route.name === 'SuggestedTab' ? suggestedScale : null);
    const baseIcon = <Ionicons name={iconName} size={size} color={color} />;
    const showPlanBadge = (route.name === 'SuggestedTab') && isPlanGenerating;
    if (!scaleVal && !showPlanBadge) return baseIcon;
    return (
      <Animated.View style={{ transform: scaleVal ? [{ scale: scaleVal }] : undefined }}>
        {baseIcon}
        {showPlanBadge ? (
          <View style={{ position: 'absolute', right: -2, top: -2, backgroundColor: '#0EA5E9', borderRadius: 8, padding: 2 }}>
            <Ionicons name="time-outline" size={10} color="#fff" />
          </View>
        ) : null}
      </Animated.View>
    );
  }, [articleScale, suggestedScale, isPlanGenerating]);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ focused, color, size }) => renderIcon(route, focused, color, size),
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
      <Tab.Screen
        name="SuggestedTab"
        component={SuggestedPlansScreen}
        options={{
          title: '提案',
          tabBarBadge: unreadSuggested > 0 ? (unreadSuggested > 9 ? '9+' : unreadSuggested) : undefined,
          tabBarBadgeStyle: { backgroundColor: '#FF3B30' },
        }}
      />
      <Tab.Screen
        name="ArticleHub"
        component={ArticleHubScreen}
        options={{
          title: '月齢記事',
          tabBarBadge: unreadArticles > 0 ? (unreadArticles > 9 ? '9+' : unreadArticles) : undefined,
          tabBarBadgeStyle: { backgroundColor: '#FF3B30' },
        }}
      />
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
