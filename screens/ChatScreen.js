import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    ScrollView,
    StyleSheet,
    Image,
    SafeAreaView,
    ActivityIndicator,
    LayoutAnimation,
    Platform,
    UIManager,
    Modal,
    TextInput,
    Button,
    Alert,
    FlatList,
    KeyboardAvoidingView,
    Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
}

// 「まな先生」のペルソナ設定
const manaPersona = `あなたは育児AIキャラクター「まな先生」です。以下の人物設定と性格を一貫して保ちながら、ユーザーと自然な会話をしてください。

【名前】まな先生
【年齢】32歳
【職業】保育士（近所の認可保育園勤務）
【性格】落ち着いていて、やさしくて、頼れる存在。常に安心感と包容力を与え、育児に悩むユーザーに寄り添うことが得意。
【話し方】語尾は「〜ですね」「〜ですよ」「〜しましょうね」など、やさしく丁寧。絵文字をたまに交えて親しみやすく。適度に改行を入れる。
【関係性】ユーザーとは近所に住んでいる親しい保育士として接する。対等だが、ほんの少しだけ年上の頼れる存在として振-舞う。
【目的】ユーザーの育児を継続的に支え、孤独や不安を減らし、前向きな気持ちを引き出す。
【態度】否定せず、まず共感する姿勢。「わかります」「大変ですよね」など安心できるワードを活用。
【禁止事項】上から目線、強い命令口調、専門用語ばかり使うことは禁止。ユーザーの名前を尋ねたり、「〇〇さん」のように呼んだり、「まな先生です」のように自己紹介を繰り返すことはしない。マークダウン形式（**太字**や*リスト*など）は使用せず、プレーンテキストで回答すること。
`;

const staticSuggestionCards = [
    { type: '献立', icon: 'restaurant-outline', text: '卵とにんじんで親子丼はどう？栄養バランスも良くて、赤ちゃんも食べやすいですよ。' },
    { type: 'ママケア', icon: 'heart-outline', text: '寝不足気味ではないですか？5分だけでも目を閉じて、肩の力を抜くストレッチをしてみてくださいね。' },
];

const defaultEventSites = [
    "https://iko-yo.net/",
    "https://peatix.com/",
    "https://jmty.jp/",
    "https://www.walkerplus.com/",
];

// LLM (Gemini) APIを呼び出す非同期関数
const callLLM = async (chatHistory) => {
    const apiKey = "AIzaSyDr-pOhBgVIcEaWWlwYu1jSQoO2uPlU-qk"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    
    if (apiKey === "YOUR_GEMINI_API_KEY") {
        const errorMessage = "APIキーが設定されていません。callLLM関数のapiKeyをあなたのキーに置き換えてください。";
        console.error(errorMessage);
        Alert.alert("設定エラー", errorMessage);
        throw new Error(errorMessage);
    }

    const payload = { contents: chatHistory };

    try {
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
             const errorBody = await res.json();
             console.error("API Error Response:", errorBody);
             throw new Error(`APIリクエストに失敗: ${res.status}`);
        }
        const result = await res.json();
        
        if (result.candidates && result.candidates[0]?.content?.parts[0]?.text) {
            return result.candidates[0].content.parts[0].text;
        } else {
            console.warn("Geminiからの応答が予期しない形式です:", result);
            return "ごめんなさい、うまくお返事できませんでした。";
        }
    } catch (error) {
        console.error("Gemini API呼び出しエラー:", error);
        throw error;
    }
};

// LLMからのテキスト応答を解析してイベントデータに変換する関数
const parseEventText = (text) => {
    if (!text) return null;
    const lines = text.split('\n');
    const eventData = {};
    let details = [];
    let isDetailsSection = false;

    for (const line of lines) {
        if (line.startsWith('---')) {
            isDetailsSection = true;
            continue;
        }
        if (isDetailsSection) {
            details.push(line);
        } else if (line.startsWith('イベント名：')) {
            eventData.eventName = line.replace('イベント名：', '').trim();
        } else if (line.startsWith('日程：')) {
            eventData.date = line.replace('日程：', '').trim();
        } else if (line.startsWith('場所：')) {
            eventData.location = line.replace('場所：', '').trim();
        } else if (line.startsWith('所要時間：')) {
            eventData.duration = line.replace('所要時間：', '').trim();
        } else if (line.startsWith('参考URL：')) {
            eventData.url = line.replace('参考URL：', '').trim();
        }
    }
    eventData.details = details.join('\n').trim();
    
    return eventData.eventName ? eventData : null;
};

// ラジオボタンのコンポーネント
const RadioButtonGroup = ({ label, options, selectedValue, onValueChange }) => (
    <View>
        <Text style={styles.inputLabel}>{label}</Text>
        <View style={styles.radioContainer}>
            {options.map(option => (
                <TouchableOpacity key={option} style={styles.radioOption} onPress={() => onValueChange(option)}>
                    <View style={styles.radioOuter}>
                        {selectedValue === option && <View style={styles.radioInner} />}
                    </View>
                    <Text>{option}</Text>
                </TouchableOpacity>
            ))}
        </View>
    </View>
);

export default function ChatScreen({ navigation }) {
    // --- State declarations ---
    const [greeting, setGreeting] = useState('...');
    const [suggestions, setSuggestions] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [expandedCardIndex, setExpandedCardIndex] = useState(null);
    const [isSettingsModalVisible, setIsSettingsModalVisible] = useState(false);
    const [refreshingCardIndex, setRefreshingCardIndex] = useState(null);
    
    // --- Settings States ---
    const [location, setLocation] = useState('');
    const [interests, setInterests] = useState('');
    const [localEventSites, setLocalEventSites] = useState([]);
    const [originalLocation, setOriginalLocation] = useState('');
    const [userName, setUserName] = useState('');
    const [userAge, setUserAge] = useState('');
    const [userGender, setUserGender] = useState('');
    const [partnerName, setPartnerName] = useState('');
    const [partnerAge, setPartnerAge] = useState('');
    const [partnerGender, setPartnerGender] = useState('');
    const [childName, setChildName] = useState('');
    const [childAge, setChildAge] = useState('');
    const [childGender, setChildGender] = useState('');

    // --- Chat States ---
    const [isChatModalVisible, setIsChatModalVisible] = useState(false);
    const [chatHistory, setChatHistory] = useState([]);
    const [userInput, setUserInput] = useState('');
    const flatListRef = useRef(null);

    // --- Voice Recording States ---
    const [recording, setRecording] = useState(null);
    const [isProcessingVoice, setIsProcessingVoice] = useState(false);
    const ws = useRef(null);

    // 地域イベントサイトを検索・保存する関数
    const updateLocalEventSites = async (currentLocation) => {
        if (!currentLocation) return;
        Alert.alert("情報収集中", `${currentLocation} のイベントサイトを検索します...`);
        try {
            const prompt = `「${currentLocation}」で、信頼できる子育て関連のイベント情報サイトや、市区町村の公式ウェブサイトを5つ見つけてください。URLだけを改行区切りでリストアップしてください。`;
            const response = await callLLM([{ role: "user", parts: [{ text: prompt }] }]);
            const urls = response.split('\n').filter(url => url.startsWith('http'));
            
            if (urls.length > 0) {
                console.log("見つかったサイト:", urls);
                await AsyncStorage.setItem(`local_event_sites_${currentLocation}`, JSON.stringify(urls));
                setLocalEventSites(urls);
                Alert.alert("情報収集完了", "参考サイトのリストを更新しました。");
            } else {
                Alert.alert("情報が見つかりません", "参考サイトを見つけられませんでした。");
            }
        } catch (error) {
            console.error("地域イベントサイトの検索に失敗:", error);
            Alert.alert("エラー", "サイトの検索中にエラーが発生しました。");
        }
    };

    // 設定を保存し、提案を再生成する
    const handleSaveSettings = async () => {
        try {
            const settings = [
                ['user_location', location], ['user_interests', interests],
                ['user_name', userName], ['user_age', userAge], ['user_gender', userGender],
                ['partner_name', partnerName], ['partner_age', partnerAge], ['partner_gender', partnerGender],
                ['child_name', childName], ['child_age', childAge], ['child_gender', childGender],
            ];
            await AsyncStorage.multiSet(settings);

            if (originalLocation !== location) {
                await updateLocalEventSites(location);
            }
            setOriginalLocation(location);
            setIsSettingsModalVisible(false);
        } catch (e) { Alert.alert("エラー", "設定の保存に失敗しました。"); }
    };

    // 起動時の挨拶を生成
    const generateGreeting = useCallback(async () => {
        try {
            const history = [{ role: "user", parts: [{ text: `${manaPersona}\n\nユーザーがアプリを開きました。今の時間帯に合わせた短い挨拶（20文字以内）をしてください。` }] }];
            const message = await callLLM(history);
            const initialGreeting = message || 'こんにちは！';
            setGreeting(initialGreeting);
            setChatHistory([{ role: "model", parts: [{ text: initialGreeting }] }]);
        } catch (error) {
            setGreeting('こんにちは！');
            console.error("挨拶の生成に失敗:", error);
        }
    }, []);
    
    const generateRecordSuggestion = useCallback(async (records) => {
        if (records.length < 5) return null;
        try {
            const now = new Date();
            const oneDayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
            const oneWeekAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
            const recentRecords = records.filter(r => new Date(r.time) > oneDayAgo).map(r => `${r.time} ${r.type} ${r.data.note || ''}`).join('\n');
            const weeklyRecords = records.filter(r => new Date(r.time) <= oneDayAgo && new Date(r.time) > oneWeekAgo).map(r => `${r.time} ${r.type} ${r.data.note || ''}`).join('\n');
            if (!recentRecords) return null;
            const prompt = `直近24時間の育児記録と、その前の1週間の記録を比較し、何か気づいた変化や傾向について、やさしくポジティブな一言でコメントしてください。\n\n# 直近24時間の記録:\n${recentRecords}\n\n# 1週間の記録:\n${weeklyRecords}`;
            const message = await callLLM([{ role: "user", parts: [{ text: `${manaPersona}\n\n${prompt}` }] }]);
            return message ? { type: '記録の変化', icon: 'analytics-outline', text: message } : null;
        } catch (error) {
            console.error("記録の提案生成エラー:", error);
            return null;
        }
    }, []);
    
    // ★★★ 変更点: 日付指定を追加 ★★★
    const generateNearbyEventSuggestion = useCallback(async (records, currentLocation, currentInterests, currentLocalSites) => {
        if (!currentLocation) return null;
        try {
            const userMood = records.slice(-10).some(r => r.data.note && (r.data.note.includes('大変') || r.data.note.includes('疲れた'))) ? '少し疲れ気味' : '通常';
            const combinedSites = [...new Set([...defaultEventSites, ...currentLocalSites])];
            const siteReference = combinedSites.length > 0
                ? `以下の参考サイトの情報を最優先で使って、`
                : `インターネットで検索して、`;

            const today = new Date();
            const threeDaysLater = new Date();
            threeDaysLater.setDate(today.getDate() + 3);
            const formatDate = (date) => date.toISOString().split('T')[0];

            const prompt = `
# 指示
${siteReference}ユーザーに合った近所のイベントを1つ提案してください。
# ユーザー情報
- 居住地: ${currentLocation}
- 興味: ${currentInterests}
- 様子: ${userMood}
# 参考サイト
${combinedSites.join('\n')}
# 条件
- **開催日が${formatDate(today)}から${formatDate(threeDaysLater)}までのイベントを厳守**
- 平日に母親が一人で赤ちゃんを連れて気軽に行けるもの
- 移動手段: 徒歩、自転車、または電車で1〜2駅以内
- 移動時間: 15分以内
- 所要時間: 1〜2時間程度
# 出力フォーマット
イベント名：[イベント名]
日程：[開催日や期間]
場所：[場所]
所要時間：[移動時間と所要時間の目安]
参考URL：[可能であればURL]
---
[まな先生からの、なぜそれをおすすめするのかというコメント(200文字程度)]
`;
            const message = await callLLM([{ role: "user", parts: [{ text: `${manaPersona}\n\n${prompt}` }] }]);
            const eventData = parseEventText(message);
            return eventData ? { type: '近所のイベント', icon: 'walk-outline', data: eventData } : null;
        } catch (error) {
            console.error("近所のイベント提案生成エラー:", error);
            return null;
        }
    }, []);

    // ★★★ 変更点: 日付指定を追加 ★★★
    const generateWeekendEventSuggestion = useCallback(async (currentLocation, currentInterests, currentLocalSites) => {
        if (!currentLocation) return null;
        const today = new Date();
        if (today.getDay() < 4) return null; // 木曜日以降に表示

        try {
            const combinedSites = [...new Set([...defaultEventSites, ...currentLocalSites])];
            const siteReference = combinedSites.length > 0
                ? `以下の参考サイトの情報を最優先で使って、`
                : `インターネットで検索して、`;

            const sevenDaysLater = new Date();
            sevenDaysLater.setDate(today.getDate() + 7);
            const formatDate = (date) => date.toISOString().split('T')[0];

            const prompt = `
# 指示
${siteReference}ユーザーに合った今週末の特別なイベントやアクティビティを1つ提案してください。
# ユーザー情報
- 居住地: ${currentLocation}
- 興味: ${currentInterests}
# 参考サイト
${defaultEventSites.join('\n')}
# 条件
- **開催日が${formatDate(today)}から${formatDate(sevenDaysLater)}までのイベントを厳守**
- 家族で楽しめるもの
- 移動時間: 60分程度以内
- 半日以上時間が使えるような特別なもの
# 出力フォーマット
イベント名：[イベント名]
日程：[開催日や期間]
場所：[場所]
所要時間：[移動時間と所要時間の目安]
参考URL：[可能であればURL]
---
[まな先生からの、なぜそれをおすすめするのかというコメント(200文字程度)]
`;
            const message = await callLLM([{ role: "user", parts: [{ text: `${manaPersona}\n\n${prompt}` }] }]);
            const eventData = parseEventText(message);
            return eventData ? { type: '週末のイベント', icon: 'car-sport-outline', data: eventData } : null;
        } catch (error) {
            console.error("週末のイベント提案生成エラー:", error);
            return null;
        }
    }, []);

    const handleRefreshSuggestion = async (indexToRefresh, type) => {
        if (refreshingCardIndex !== null) return;
        setRefreshingCardIndex(indexToRefresh);
        let newSuggestion = null;
        try {
            const rawData = await AsyncStorage.getItem('records');
            const records = rawData ? JSON.parse(rawData) : [];
            switch (type) {
                case '記録の変化':
                    newSuggestion = await generateRecordSuggestion(records);
                    break;
                case '近所のイベント':
                    newSuggestion = await generateNearbyEventSuggestion(records, location, interests, localEventSites);
                    break;
                case '週末のイベント':
                    newSuggestion = await generateWeekendEventSuggestion(location, interests, localEventSites);
                    break;
            }
            if (newSuggestion) {
                setSuggestions(currentSuggestions => {
                    const newSuggestions = [...currentSuggestions];
                    newSuggestions[indexToRefresh] = newSuggestion;
                    return newSuggestions;
                });
            } else {
                Alert.alert("ごめんなさい", "新しい提案を見つけられませんでした。");
            }
        } catch (error) {
            console.error(`Error refreshing suggestion for type ${type}:`, error);
            Alert.alert("エラー", "提案の更新中にエラーが発生しました。");
        } finally {
            setRefreshingCardIndex(null);
        }
    };

    useEffect(() => {
        const loadInitialData = async () => {
            setIsLoading(true);
            try {
                const keys = ['user_location', 'user_interests', 'user_name', 'user_age', 'user_gender', 'partner_name', 'partner_age', 'partner_gender', 'child_name', 'child_age', 'child_gender'];
                const settings = await AsyncStorage.multiGet(keys);
                const settingsObj = Object.fromEntries(settings);
                
                const loadedLocation = settingsObj.user_location || '';
                setLocation(loadedLocation);
                setOriginalLocation(loadedLocation);
                setInterests(settingsObj.user_interests || '');
                setUserName(settingsObj.user_name || '');
                setUserAge(settingsObj.user_age || '');
                setUserGender(settingsObj.user_gender || '');
                setPartnerName(settingsObj.partner_name || '');
                setPartnerAge(settingsObj.partner_age || '');
                setPartnerGender(settingsObj.partner_gender || '');
                setChildName(settingsObj.child_name || '');
                setChildAge(settingsObj.child_age || '');
                setChildGender(settingsObj.child_gender || '');
                
                if (loadedLocation) {
                    const storedSites = await AsyncStorage.getItem(`local_event_sites_${loadedLocation}`);
                    if (storedSites) {
                        setLocalEventSites(JSON.parse(storedSites));
                    } else {
                        await updateLocalEventSites(loadedLocation);
                    }
                } else {
                    setIsSettingsModalVisible(true);
                }
            } catch (e) {
                console.error("設定の読み込みに失敗", e);
            }
            await generateGreeting();
            setIsLoading(false);
        };

        loadInitialData();
    }, [generateGreeting]);

    useEffect(() => {
        if (isLoading || !location) {
            setSuggestions([]);
            return;
        }

        const getSuggestions = async () => {
            try {
                const rawData = await AsyncStorage.getItem('records');
                const records = rawData ? JSON.parse(rawData) : [];
                
                const suggestionPromises = [
                    generateRecordSuggestion(records),
                    generateNearbyEventSuggestion(records, location, interests, localEventSites),
                    generateWeekendEventSuggestion(location, interests, localEventSites),
                ];
    
                const dynamicSuggestions = (await Promise.all(suggestionPromises)).filter(Boolean);
                setSuggestions([...dynamicSuggestions, ...staticSuggestionCards]);
            } catch (e) {
                console.error('提案全体の生成エラー:', e);
                setSuggestions(staticSuggestionCards);
            }
        };

        getSuggestions();
    }, [location, interests, localEventSites, isLoading, generateRecordSuggestion, generateNearbyEventSuggestion, generateWeekendEventSuggestion]);


    const toggleCardExpansion = (index) => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setExpandedCardIndex(expandedCardIndex === index ? null : index);
    };

    const handleSendMessage = async () => {
        if (!userInput.trim() || isProcessingVoice) return;
        const newUserMessage = { role: "user", parts: [{ text: userInput }] };
        const newHistory = [...chatHistory, newUserMessage];
        setChatHistory(newHistory);
        setUserInput('');
        try {
            const botResponse = await callLLM(newHistory);
            if (botResponse) {
                const newBotMessage = { role: "model", parts: [{ text: botResponse }] };
                setChatHistory(prev => [...prev, newBotMessage]);
            }
        } catch (e) {
            const errorMessage = { role: "model", parts: [{ text: "ごめんなさい、うまく応答できませんでした。" }] };
            setChatHistory(prev => [...prev, errorMessage]);
        }
    };

    const startChatRecording = async () => {
        try {
            const { status } = await Audio.requestPermissionsAsync();
            if (status !== 'granted') {
                Alert.alert('権限が必要です', 'マイクの使用を許可してください。');
                return;
            }
            await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
            const newRecording = new Audio.Recording();
            await newRecording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
            await newRecording.startAsync();
            setRecording(newRecording);
        } catch (err) { console.error('録音開始に失敗:', err); }
    };

    const stopChatRecording = async () => {
        if (!recording) return;
        try {
            await recording.stopAndUnloadAsync();
            const uri = recording.getURI();
            setRecording(null);
            if (uri) {
                connectWebSocketForChat(uri);
            }
        } catch (error) { console.error('録音停止に失敗:', error); }
    };

    const connectWebSocketForChat = (uri) => {
        const wsUrl = 'ws://10.0.2.2:8090';
        ws.current = new WebSocket(wsUrl);
        setIsProcessingVoice(true);
        ws.current.onopen = async () => {
            try {
                const base64Audio = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
                ws.current.send(JSON.stringify({ audio: base64Audio }));
            } catch (error) {
                Alert.alert('エラー', '音声の処理に失敗しました。');
                setIsProcessingVoice(false);
                if (ws.current) ws.current.close();
            }
        };
        ws.current.onmessage = (e) => {
            const message = JSON.parse(e.data);
            if (message.text) {
                setUserInput(prev => (prev + ' ' + message.text).trim());
            }
            if (ws.current) ws.current.close();
        };
        ws.current.onerror = (e) => {
            Alert.alert('接続エラー', '音声認識サーバーに接続できませんでした。');
            setIsProcessingVoice(false);
        };
        ws.current.onclose = () => {
            setIsProcessingVoice(false);
            ws.current = null;
        };
    };

    const dynamicSuggestionTypes = ['記録の変化', '近所のイベント', '週末のイベント'];

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView contentContainerStyle={styles.scrollContainer}>
                <View style={styles.characterContainer}>
                    <Image source={require('../assets/mana.png')} style={styles.characterImage} resizeMode="contain" />
                    <View style={styles.speechBubble}>
                        {isLoading ? <ActivityIndicator /> : <Text style={styles.speechText}>{greeting}</Text>}
                        <TouchableOpacity style={styles.chatLink} onPress={() => setIsChatModalVisible(true)}>
                            <Text style={styles.chatLinkText}>チャットする</Text>
                        </TouchableOpacity>
                    </View>
                </View>

                <View style={styles.suggestionSection}>
                    <View style={styles.sectionHeader}>
                        <Text style={styles.sectionTitle}>今日のおすすめ</Text>
                        <TouchableOpacity onPress={() => setIsSettingsModalVisible(true)}>
                            <Ionicons name="settings-outline" size={24} color="#888" />
                        </TouchableOpacity>
                    </View>
                    <View style={styles.cardListContainer}>
                        {isLoading ? <ActivityIndicator style={{marginTop: 20}} /> : (
                            suggestions.map((card, index) => {
                                const isExpanded = expandedCardIndex === index;
                                const isDynamic = dynamicSuggestionTypes.includes(card.type);
                                return (
                                    <TouchableOpacity key={index} style={styles.card} onPress={() => toggleCardExpansion(index)} activeOpacity={0.8}>
                                        <View style={styles.cardHeader}>
                                            <View style={styles.cardHeaderLeft}>
                                                <Ionicons name={card.icon || 'happy-outline'} size={22} color="#555" style={styles.cardIcon} />
                                                <Text style={styles.cardType}>{card.type}</Text>
                                            </View>
                                            {isDynamic && (
                                                <View>
                                                    {refreshingCardIndex === index ? (
                                                        <ActivityIndicator size="small" color="#6C63FF" />
                                                    ) : (
                                                        <TouchableOpacity onPress={(e) => { e.stopPropagation(); handleRefreshSuggestion(index, card.type); }}>
                                                            <Ionicons name="refresh" size={24} color="#888" />
                                                        </TouchableOpacity>
                                                    )}
                                                </View>
                                            )}
                                        </View>
                                        
                                        {card.data ? (
                                            <View>
                                                <Text style={styles.eventInfo} selectable>
                                                    <Text style={styles.eventLabel}>イベント名：</Text>{card.data.eventName}{'\n'}
                                                    {card.data.date && <><Text style={styles.eventLabel}>日程：</Text>{card.data.date}{'\n'}</>}
                                                    {card.data.location && <><Text style={styles.eventLabel}>場所：</Text>{card.data.location}{'\n'}</>}
                                                    {card.data.duration && <><Text style={styles.eventLabel}>所要時間：</Text>{card.data.duration}</>}
                                                </Text>
                                                {card.data.url ? (
                                                    <TouchableOpacity onPress={() => Linking.openURL(card.data.url).catch(err => console.error("Couldn't load page", err))}>
                                                        <Text style={styles.eventUrl} numberOfLines={1}>
                                                            <Text style={styles.eventLabel}>参考URL：</Text>{card.data.url}
                                                        </Text>
                                                    </TouchableOpacity>
                                                ) : null}
                                                {isExpanded && <Text style={styles.cardTextDetails} selectable>{card.data.details}</Text>}
                                            </View>
                                        ) : (
                                            <Text style={styles.cardText} numberOfLines={isExpanded ? 0 : 2}>{card.text}</Text>
                                        )}
                                    </TouchableOpacity>
                                );
                            })
                        )}
                    </View>
                </View>

                <View style={styles.actionsContainer}>
                    <TouchableOpacity style={styles.actionButton}><Ionicons name="search-outline" size={22} color="white" /><Text style={styles.actionButtonText}>イベント検索</Text></TouchableOpacity>
                    <TouchableOpacity style={styles.actionButton} onPress={() => navigation.navigate('Record')}><Ionicons name="create-outline" size={22} color="white" /><Text style={styles.actionButtonText}>記録する</Text></TouchableOpacity>
                </View>
            </ScrollView>

            <View style={styles.navBar}>
                <TouchableOpacity style={styles.navButton}><Ionicons name="home" size={24} color="#6C63FF" /><Text style={[styles.navText, {color: '#6C63FF'}]}>ホーム</Text></TouchableOpacity>
                <TouchableOpacity style={styles.navButton} onPress={() => navigation.navigate('Record')}><Ionicons name="calendar-outline" size={24} color="#555" /><Text style={styles.navText}>記録</Text></TouchableOpacity>
                <TouchableOpacity style={styles.navButton}><Ionicons name="gift-outline" size={24} color="#555" /><Text style={styles.navText}>ごほうび</Text></TouchableOpacity>
                <TouchableOpacity style={styles.navButton}><Ionicons name="settings-outline" size={24} color="#555" /><Text style={styles.navText}>設定</Text></TouchableOpacity>
            </View>
            
            <Modal visible={isSettingsModalVisible} onRequestClose={() => setIsSettingsModalVisible(false)} transparent={true} animationType="fade">
                <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalContainer}>
                    <View style={styles.modalScrollViewContainer}>
                        <ScrollView>
                            <View style={styles.modalContent}>
                                <Text style={styles.modalTitle}>プロフィール設定</Text>
                                
                                <Text style={styles.inputLabel}>お住まいの地域 (市区町村まで)</Text>
                                <TextInput style={styles.input} value={location} onChangeText={setLocation} placeholder="例：神奈川県横浜市" />
                                
                                <Text style={styles.inputLabel}>興味・関心</Text>
                                <TextInput style={styles.input} value={interests} onChangeText={setInterests} placeholder="例：動物, 自然, 音楽" />

                                <View style={styles.debugSection}>
                                    <Text style={styles.inputLabel}>デバッグ用: 参考サイト</Text>
                                    <TouchableOpacity style={styles.debugButton} onPress={() => updateLocalEventSites(location)}>
                                        <Text style={styles.debugButtonText}>参考サイトを再取得</Text>
                                    </TouchableOpacity>
                                    <View style={styles.debugSiteList}>
                                        {localEventSites.length > 0 ? (
                                            localEventSites.map((site, index) => (
                                                <Text key={index} style={styles.debugSiteText} selectable>{`・${site}`}</Text>
                                            ))
                                        ) : (
                                            <Text style={styles.debugSiteText}>参考サイトはありません。</Text>
                                        )}
                                    </View>
                                </View>

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
                                
                                <View style={styles.modalButtonContainer}><Button title="キャンセル" onPress={() => setIsSettingsModalVisible(false)} color="#888" /><Button title="保存" onPress={handleSaveSettings} /></View>
                            </View>
                        </ScrollView>
                    </View>
                </KeyboardAvoidingView>
            </Modal>

            <Modal visible={isChatModalVisible} onRequestClose={() => setIsChatModalVisible(false)} transparent={true} animationType="slide">
                <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalContainer}>
                    <TouchableOpacity style={styles.modalBackdrop} onPress={() => setIsChatModalVisible(false)} activeOpacity={1} />
                    <View style={styles.chatModalContent}>
                        <FlatList ref={flatListRef} data={chatHistory} keyExtractor={(item, index) => index.toString()} renderItem={({ item }) => (<View style={[styles.messageBubble, item.role === 'user' ? styles.userBubble : styles.modelBubble]}><Text style={styles.messageText}>{item.parts[0].text}</Text></View>)} onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })} contentContainerStyle={{ padding: 10 }} />
                        <View style={styles.inputContainer}>
                            <TextInput style={styles.chatInput} value={userInput} onChangeText={setUserInput} placeholder="まな先生にメッセージを送る..." multiline />
                            <TouchableOpacity style={[styles.chatMicButton, recording && styles.recordingButton]} onPress={recording ? stopChatRecording : startChatRecording} disabled={isProcessingVoice}>
                                {isProcessingVoice ? <ActivityIndicator color="white" /> : <Ionicons name="mic" size={24} color="white" />}
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.sendButton} onPress={handleSendMessage}><Ionicons name="send" size={24} color="white" /></TouchableOpacity>
                        </View>
                    </View>
                </KeyboardAvoidingView>
            </Modal>
        </SafeAreaView>
    );
}

// スタイル定義
const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#FFF8F0' },
    scrollContainer: { paddingBottom: 90 },
    characterContainer: { alignItems: 'center', paddingVertical: 10 },
    characterImage: { width: '70%', height: 200 },
    speechBubble: { backgroundColor: 'white', padding: 16, borderRadius: 20, marginTop: -20, width: '90%', minHeight: 80, justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4, elevation: 3, paddingRight: 80 },
    speechText: { fontSize: 15, color: '#333', lineHeight: 22 },
    chatLink: { position: 'absolute', bottom: 10, right: 15 },
    chatLinkText: { fontSize: 14, color: '#6C63FF', fontWeight: 'bold' },
    suggestionSection: { marginTop: 16 },
    sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: 16, marginBottom: 12 },
    sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#444' },
    cardListContainer: { paddingHorizontal: 16 },
    card: { borderRadius: 12, padding: 14, marginBottom: 10, backgroundColor: 'white', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2, overflow: 'hidden' },
    cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
    cardHeaderLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, paddingRight: 10 },
    cardIcon: { marginRight: 10 },
    cardType: { fontWeight: 'bold', fontSize: 15, color: '#333', flexShrink: 1 },
    cardText: { fontSize: 14, color: '#555', lineHeight: 21 },
    eventInfo: { fontSize: 14, color: '#555', lineHeight: 21 },
    eventLabel: { fontWeight: 'bold', color: '#333' },
    cardTextDetails: { fontSize: 14, color: '#555', lineHeight: 21, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
    eventUrl: {
        fontSize: 14,
        color: '#007AFF',
        textDecorationLine: 'underline',
        marginTop: 4,
    },
    actionsContainer: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 24, paddingHorizontal: 16 },
    actionButton: { flexDirection: 'row', backgroundColor: '#6C63FF', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 30, alignItems: 'center', shadowColor: '#6C63FF', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 5, elevation: 6 },
    actionButtonText: { color: 'white', fontWeight: 'bold', marginLeft: 8, fontSize: 15 },
    navBar: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 75, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', backgroundColor: 'white', borderTopWidth: 1, borderColor: '#eee', paddingBottom: Platform.OS === 'ios' ? 20 : 5 },
    navButton: { alignItems: 'center', flex: 1 },
    navText: { fontSize: 11, color: '#555', marginTop: 2 },
    modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
    modalScrollViewContainer: {
        width: '90%',
        maxHeight: '85%',
        backgroundColor: 'white',
        borderRadius: 20,
    },
    modalContent: {
        padding: 20,
    },
    modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 16, textAlign: 'center' },
    inputLabel: { fontSize: 16, color: '#333', marginBottom: 8, marginTop: 8, fontWeight: 'bold' },
    input: { backgroundColor: '#f0f0f0', borderRadius: 10, padding: 12, fontSize: 16, marginBottom: 8 },
    formRow: { flexDirection: 'row', gap: 10 },
    radioContainer: { flexDirection: 'row', marginBottom: 12, flexWrap: 'wrap' },
    radioOption: { flexDirection: 'row', alignItems: 'center', marginRight: 15, paddingVertical: 5 },
    radioOuter: { height: 20, width: 20, borderRadius: 10, borderWidth: 2, borderColor: '#6C63FF', alignItems: 'center', justifyContent: 'center', marginRight: 5 },
    radioInner: { height: 10, width: 10, borderRadius: 5, backgroundColor: '#6C63FF' },
    modalButtonContainer: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 16 },
    modalBackdrop: { ...StyleSheet.absoluteFillObject },
    chatModalContent: { height: '90%', width: '100%', backgroundColor: '#F0F4F8', position: 'absolute', bottom: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
    messageBubble: { padding: 12, borderRadius: 18, marginBottom: 10, maxWidth: '80%' },
    userBubble: { backgroundColor: '#C9F0FF', alignSelf: 'flex-end', borderBottomRightRadius: 4 },
    modelBubble: { backgroundColor: '#FFFFFF', alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
    messageText: { fontSize: 16, lineHeight: 22 },
    inputContainer: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: '#ddd', padding: 8, backgroundColor: '#fff' },
    chatInput: { flex: 1, backgroundColor: '#fff', borderRadius: 22, paddingHorizontal: 15, paddingVertical: Platform.OS === 'ios' ? 12 : 8, fontSize: 16, maxHeight: 100 },
    chatMicButton: { marginLeft: 8, backgroundColor: '#6C63FF', borderRadius: 22, width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
    recordingButton: { backgroundColor: '#FF6347' },
    sendButton: { marginLeft: 8, backgroundColor: '#6C63FF', borderRadius: 22, width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
    debugSection: {
        marginTop: 12,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: '#eee',
    },
    debugButton: {
        backgroundColor: '#e0e0e0',
        paddingVertical: 10,
        borderRadius: 8,
        alignItems: 'center',
        marginBottom: 10,
    },
    debugButtonText: {
        color: '#333',
        fontWeight: 'bold',
    },
    debugSiteList: {
        padding: 10,
        backgroundColor: '#f5f5f5',
        borderRadius: 8,
    },
    debugSiteText: {
        fontSize: 12,
        color: '#666',
        marginBottom: 4,
    },
});
