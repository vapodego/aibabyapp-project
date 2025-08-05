// aibabyapp-project/app/App.js (APIキー分離対応版)

// Navigation & React
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { useEffect, useState, useRef } from 'react';

// Screens
import RecordScreen from './screens/RecordScreen';
import ChatScreen from './screens/ChatScreen';
import PlanScreen from './screens/PlanScreen';

// Utilities
import { loadInitialRecords } from './utils/loadInitialRecords';

// Firebase & Notifications
import { Platform, Alert } from 'react-native';
import { initializeApp } from 'firebase/app';
import { initializeAuth, getReactNativePersistence, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';
import { getFirestore, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

// ▼▼▼【ここから修正】環境変数からAPIキーをインポート ▼▼▼
import { 
    API_KEY, 
    AUTH_DOMAIN, 
    PROJECT_ID, 
    STORAGE_BUCKET, 
    MESSAGING_SENDER_ID, 
    APP_ID, 
    MEASUREMENT_ID 
} from '@env';
// ▲▲▲【ここまで修正】▲▲▲

// --- Stack Navigator ---
const Stack = createNativeStackNavigator();

// ▼▼▼【ここから修正】環境変数を使ってFirebase Configを構築 ▼▼▼
const firebaseConfig = {
    apiKey: API_KEY,
    authDomain: AUTH_DOMAIN,
    projectId: PROJECT_ID,
    storageBucket: STORAGE_BUCKET,
    messagingSenderId: MESSAGING_SENDER_ID,
    appId: APP_ID,
    measurementId: MEASUREMENT_ID
};
// ▲▲▲【ここまで修正】▲▲▲

// --- Firebase Initialization ---
const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, {
    persistence: getReactNativePersistence(ReactNativeAsyncStorage)
});
const db = getFirestore(app);

// --- Notification Handler ---
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
    }),
});

// --- Push Token Helper Function ---
async function registerForPushNotificationsAsync() {
    let token;

    if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
            name: 'default',
            importance: Notifications.AndroidImportance.MAX,
            vibrationPattern: [0, 250, 250, 250],
            lightColor: '#FF231F7C',
        });
    }

    if (Device.isDevice) {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        if (existingStatus !== 'granted') {
            const { status } = await Notifications.requestPermissionsAsync();
            finalStatus = status;
        }
        if (finalStatus !== 'granted') {
            Alert.alert('プッシュ通知の許可に失敗しました！');
            return;
        }
        
        // ExpoのProject IDは秘密情報ではないのでそのままでOK
        const expoProjectId = "770bbefb-c4f8-4c4a-ad73-08c69cbe8ce7";
        token = (await Notifications.getExpoPushTokenAsync({ projectId: expoProjectId })).data;
        console.log("【Push Token】:", token);

    } else {
        Alert.alert('プッシュ通知は実機でテストする必要があります');
    }

    return token;
}

// --- Main App Component ---
export default function App() {
    const [userId, setUserId] = useState(null);
    const notificationListener = useRef();
    const responseListener = useRef();

    useEffect(() => {
        // --- 1. 初期データロード ---
        loadInitialRecords();

        // --- 2. Firebase認証とPushトークン処理 ---
        const initializeAppAndGetToken = async (user) => {
            if (user) {
                const currentUserId = user.uid;
                setUserId(currentUserId);
                console.log("ログイン成功: UserID -", currentUserId);

                try {
                    const token = await registerForPushNotificationsAsync();
                    if (token) {
                        console.log("トークンをFirestoreに保存中...");
                        await setDoc(doc(db, 'users', currentUserId), {
                            expoPushToken: token,
                            updatedAt: serverTimestamp(),
                        }, { merge: true });
                        console.log("Firestoreへのトークン保存成功");
                    }
                } catch (e) {
                    console.error("トークンの取得または保存に失敗しました:", e);
                    Alert.alert('トークンエラー', e.message);
                }
            } else {
                 signInAnonymously(auth).catch(error => {
                     console.error("匿名ログインに失敗:", error);
                     Alert.alert('認証エラー', 'サーバーへの接続に失敗しました。');
                 });
            }
        };
        
        const unsubscribe = onAuthStateChanged(auth, initializeAppAndGetToken);

        // --- 3. 通知リスナー設定 ---
        notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
            console.log('フォアグラウンドで通知を受信:', notification);
        });

        responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
            console.log('ユーザーが通知をタップしました:', response);
        });

        // --- 4. クリーンアップ ---
        return () => {
            unsubscribe();
            if (notificationListener.current) {
                Notifications.removeNotificationSubscription(notificationListener.current);
            }
            if (responseListener.current) {
                Notifications.removeNotificationSubscription(responseListener.current);
            }
        };
    }, []);

    // --- NavigationにPlanScreenを追加 ---
    return (
        <NavigationContainer>
            <Stack.Navigator initialRouteName="Chat">
                <Stack.Screen name="Chat" component={ChatScreen} options={{ headerShown: false }} />
                <Stack.Screen name="Record" component={RecordScreen} options={{ title: '育児記録' }}/>
                <Stack.Screen 
                  name="Plan" 
                  component={PlanScreen} 
                  options={{ headerShown: false }}
                />
            </Stack.Navigator>
        </NavigationContainer>
    );
}
