// aibabyapp/App.js (Expo Project ID指定版)

import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import RecordScreen from './screens/RecordScreen';
import ChatScreen from './screens/ChatScreen';
import React, { useEffect, useState, useRef } from 'react';
import { loadInitialRecords } from './utils/loadInitialRecords';

// ▼▼▼【ここから追加】通知機能とFirebase連携に必要なモジュールをインポート ▼▼▼
import { Platform, Text, View, Button, Alert } from 'react-native';
import { initializeApp } from 'firebase/app';
import { initializeAuth, getReactNativePersistence, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';
import { getFirestore, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
// ▲▲▲【ここまで追加】▲▲▲


const Stack = createNativeStackNavigator();

// ▼▼▼【ここから追加】Firebaseの設定情報と初期化処理 ▼▼▼
const firebaseConfig = {
    apiKey: "AIzaSyC4zuAs6BAIY83VNRGkFWyBTMJVy2MWZxg",
    authDomain: "aibabyapp-abeae.firebaseapp.com",
    projectId: "aibabyapp-abeae",
    storageBucket: "aibabyapp-abeae.firebasestorage.app",
    messagingSenderId: "572812887246",
    appId: "1:572812887246:web:b37f645f91c15af6233c9f",
    measurementId: "G-FE4HKSDBZD"
};

// Firebaseの初期化
const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, {
    persistence: getReactNativePersistence(ReactNativeAsyncStorage)
});
const db = getFirestore(app);

// --- 通知の表示設定 ---
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
    }),
});

// --- Push通知の許可とトークン取得を行うヘルパー関数 ---
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
        
        // ▼▼▼【再修正】ExpoのプロジェクトIDを直接指定します ▼▼▼
        // ExpoのプロジェクトIDが見つからないというエラーのため、app.jsonからIDをコピーしてここに貼り付けてください。
        // IDは `npx eas project:init` を実行すると生成され、app.json内の "extra": { "eas": { "projectId": "..." } } に記載されています。
        const expoProjectId = "770bbefb-c4f8-4c4a-ad73-08c69cbe8ce7"; // 例: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        
        if (expoProjectId === "ここにExpoのProjectIDを貼り付け") {
            Alert.alert(
                "設定が必要です", 
                "App.js内の`expoProjectId`に、あなたのExpoプロジェクトIDを設定してください。app.jsonからコピーできます。"
            );
            return;
        }

        token = (await Notifications.getExpoPushTokenAsync({ projectId: expoProjectId })).data;
        // ▲▲▲【ここまで再修正】▲▲▲

        console.log("【Push Token】:", token);
    } else {
        Alert.alert('プッシュ通知は実機でテストする必要があります');
    }

    return token;
}
// ▲▲▲【ここまで追加】▲▲▲


export default function App() {
    // ▼▼▼【ここから追加】ユーザーIDや通知リスナーを管理するためのstateとref ▼▼▼
    const [userId, setUserId] = useState(null);
    const notificationListener = useRef();
    const responseListener = useRef();
    // ▲▲▲【ここまで追加】▲▲▲

    useEffect(() => {
        // --- 1. 既存の初期データロードを実行 ---
        loadInitialRecords();

        // --- 2. Firebaseへの匿名ログインとPushトークンの処理 ---
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
                 // ユーザーがまだログインしていない場合、匿名でログインする
                 signInAnonymously(auth).catch(error => {
                     console.error("匿名ログインに失敗:", error);
                     Alert.alert('認証エラー', 'サーバーへの接続に失敗しました。');
                 });
            }
        };
        
        // 認証状態の変化を監視し、ログインが確認できたら各種初期化処理を実行
        const unsubscribe = onAuthStateChanged(auth, initializeAppAndGetToken);

        // --- 3. 通知リスナーを設定 ---
        notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
            console.log('フォアグラウンドで通知を受信:', notification);
            // ここで通知受信時のグローバルな状態更新などが可能
        });

        responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
            console.log('ユーザーが通知をタップしました:', response);
            // ここで通知をタップした際の画面遷移などが可能
        });

        // --- 4. クリーンアップ処理 ---
        return () => {
            unsubscribe(); // 認証監視を解除
            if (notificationListener.current) {
                Notifications.removeNotificationSubscription(notificationListener.current);
            }
            if (responseListener.current) {
                Notifications.removeNotificationSubscription(responseListener.current);
            }
        };
    }, []);


    return (
        <NavigationContainer>
            <Stack.Navigator initialRouteName="Chat">
                {/* 画面コンポーネントにuserIdを渡すことも可能 */}
                <Stack.Screen name="Chat" component={ChatScreen} options={{ headerShown: false }} />
                <Stack.Screen name="Record" component={RecordScreen} />
            </Stack.Navigator>
        </NavigationContainer>
    );
}
