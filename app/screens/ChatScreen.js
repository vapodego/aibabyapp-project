import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    ScrollView,
    StyleSheet,
    Image,
    ActivityIndicator,
    LayoutAnimation,
    Platform,
    UIManager,
    Modal,
    TextInput,
    Alert,
    FlatList,
    KeyboardAvoidingView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getFirestore, doc, onSnapshot } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';


if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
}

const staticSuggestionCards = [
    { type: '献立のヒント', icon: 'restaurant-outline', text: '卵とにんじんで親子丼はどう？栄養バランスも良くて、赤ちゃんも食べやすいですよ。' },
    { type: 'ママケア', icon: 'heart-outline', text: '寝不足気味ではないですか？5分だけでも目を閉じて、肩の力を抜くストレッチをしてみてくださいね。' },
];

export default function ChatScreen({ navigation, route }) {
    // --- State管理 ---
    const [greeting, setGreeting] = useState('...');
    const [suggestions, setSuggestions] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [expandedCardIndex, setExpandedCardIndex] = useState(null);
    const [planStatus, setPlanStatus] = useState('not_started');
    const statusRef = useRef('not_started');
    const [isChatModalVisible, setIsChatModalVisible] = useState(false);
    const [chatHistory, setChatHistory] = useState([]);
    const [userInput, setUserInput] = useState('');
    const flatListRef = useRef(null);
    const chatInputRef = useRef(null);
    const initialInjectedRef = useRef(false);
    useEffect(() => {
        const injected = route?.params?.initialText;
        if (!injected || initialInjectedRef.current) return;
        initialInjectedRef.current = true;
        setIsChatModalVisible(true);
        setUserInput(injected);
        setTimeout(() => chatInputRef.current?.focus(), 250);
    }, [route?.params?.initialText]);
    const insets = useSafeAreaInsets();
    const bottomPadding = (Platform.OS === 'ios' ? insets.bottom + 80 : insets.bottom + 70);
    
    // --- 副作用 (データ読み込み & 監視) ---
    const generateGreeting = useCallback(async () => {
        const initialGreeting = 'こんにちは！今日の調子はどうですか？';
        setGreeting(initialGreeting);
        setChatHistory([{ role: "model", parts: [{ text: "こんにちは！まな先生です。何かお困りのことはありますか？" }] }]);
    }, []);
    
    useEffect(() => {
        const loadInitialData = async () => {
            setIsLoading(true);
            await generateGreeting();
            setSuggestions(staticSuggestionCards);
            setIsLoading(false);
        };
        loadInitialData();
    }, [generateGreeting]);

    useFocusEffect(
        useCallback(() => {
            let unsubscribe = null;
            let cancelled = false;

            const run = async () => {
                try {
                    const auth = getAuth();
                    let user = auth.currentUser;
                    if (!user) {
                        // 匿名認証でログイン（未ログイン時）
                        try {
                            await signInAnonymously(auth);
                            user = auth.currentUser;
                        } catch (e) {
                            console.error('匿名認証に失敗:', e);
                            setPlanStatus('not_started');
                            return;
                        }
                    }

                    if (!user || cancelled) return;

                    const db = getFirestore();
                    unsubscribe = onSnapshot(
                        doc(db, 'users', user.uid),
                        (docSnap) => {
                            const raw = docSnap.data()?.planGenerationStatus;
                            const valid = (typeof raw === 'string' && ['not_started','in_progress','completed','error'].includes(raw)) ? raw : undefined;
                            const next = (valid === undefined) ? statusRef.current : valid;
                            if (next !== statusRef.current) {
                                statusRef.current = next;
                                setPlanStatus(next);
                            }
                        },
                        (error) => {
                            // console.error('プラン状況の監視に失敗:', error);
                            setPlanStatus('not_started');
                        }
                    );
                } catch (err) {
                    console.error('useFocusEffect run error:', err);
                }
            };

            run();

            return () => {
                cancelled = true;
                if (typeof unsubscribe === 'function') {
                    unsubscribe();
                }
            };
        }, [])
    );

    // --- イベントハンドラ ---
    const toggleCardExpansion = (index) => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setExpandedCardIndex(expandedCardIndex === index ? null : index);
    };
    
    const handleSendMessage = async () => {
        if (!userInput.trim()) return;
        const newUserMessage = { role: "user", parts: [{ text: userInput }] };
        setChatHistory(prev => [...prev, newUserMessage]);
        setUserInput('');
        const botResponse = "ごめんなさい、今はまな先生とお話しできません。もうすぐお話しできるようになりますので、待っていてくださいね。";
        const newBotMessage = { role: "model", parts: [{ text: botResponse }] };
        setTimeout(() => setChatHistory(prev => [...prev, newBotMessage]), 500);
    };
    

    const renderStatusBanner = () => {
        if (!planStatus || planStatus === 'not_started') return null;

        const bannerBase = [styles.banner];
        let text = '';
        if (planStatus === 'in_progress') {
            bannerBase.push({ backgroundColor: '#FFF4E5', borderColor: '#FFC78A' });
            text = 'プランを作成しています。完了までお待ちください。';
        } else if (planStatus === 'completed') {
            bannerBase.push({ backgroundColor: '#E9FFF0', borderColor: '#86E3A5' });
            text = 'プランが完成しました！';
            // Re-add the small button for completed status
            return (
                <View style={bannerBase} accessibilityLiveRegion="polite" accessible>
                    <Text style={styles.bannerText}>{text}</Text>
                    {planStatus === 'completed' && (
                        <TouchableOpacity
                            accessibilityRole="button"
                            onPress={() => navigation.navigate('SuggestedPlans')}
                            style={styles.bannerButton}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                            activeOpacity={0.7}
                        >
                            <Text style={styles.bannerButtonText}>プランを見る</Text>
                        </TouchableOpacity>
                    )}
                </View>
            );
        } else if (planStatus === 'error') {
            bannerBase.push({ backgroundColor: '#FFE9E9', borderColor: '#F5A3A3' });
            text = 'プラン作成に失敗しました';
        }

        return (
            <View style={bannerBase} accessibilityLiveRegion="polite" accessible>
                <Text style={styles.bannerText}>{text}</Text>
            </View>
        );
    };

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView contentContainerStyle={[styles.scrollContainer, { paddingBottom: bottomPadding }]}>
                <View style={styles.characterContainer}>
                    <Image source={require('../assets/mana.png')} style={styles.characterImage} resizeMode="contain" />
                    <View style={styles.speechBubble}>
                        {isLoading ? <ActivityIndicator /> : <Text style={styles.speechText}>{greeting}</Text>}
                        <TouchableOpacity style={styles.chatLink} onPress={() => setIsChatModalVisible(true)}>
                            <Text style={styles.chatLinkText}>チャットする</Text>
                        </TouchableOpacity>
                    </View>
                </View>
                {/* 提案タブへ移動：プランCTAとステータスバナーは提案タブに移設 */}

                <View style={styles.suggestionSection}>
                    <View style={styles.sectionHeader}>
                        <Text style={styles.sectionTitle}>今日のおすすめ</Text>
                    </View>
                    <View style={styles.cardListContainer}>
                        {isLoading ? <ActivityIndicator style={{marginTop: 20}} /> : (
                           suggestions.map((card, index) => (
                                <TouchableOpacity key={index} style={styles.card} onPress={() => toggleCardExpansion(index)} activeOpacity={0.8}>
                                    <View style={styles.cardHeader}>
                                        <View style={styles.cardHeaderLeft}>
                                            <Ionicons name={card.icon || 'happy-outline'} size={22} color="#555" style={styles.cardIcon} />
                                            <Text style={styles.cardType}>{card.type}</Text>
                                        </View>
                                    </View>
                                    <Text style={styles.cardText} numberOfLines={expandedCardIndex === index ? 0 : 2}>{card.text}</Text>
                                </TouchableOpacity>
                            ))
                        )}
                    </View>
                </View>
            </ScrollView>


            <Modal visible={isChatModalVisible} onRequestClose={() => setIsChatModalVisible(false)} transparent={true} animationType="slide">
                <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalContainer}>
                    <TouchableOpacity style={styles.modalBackdrop} onPress={() => setIsChatModalVisible(false)} activeOpacity={1} />
                    <View style={styles.chatModalContent}>
                        <FlatList ref={flatListRef} data={chatHistory} keyExtractor={(item, index) => index.toString()} renderItem={({ item }) => (<View style={[styles.messageBubble, item.role === 'user' ? styles.userBubble : styles.modelBubble]}><Text style={styles.messageText}>{item.parts[0].text}</Text></View>)} onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })} contentContainerStyle={{ padding: 10 }} />
                        <View style={styles.inputContainer}>
                            <TextInput
                                ref={chatInputRef}
                                style={styles.chatInput}
                                value={userInput}
                                onChangeText={setUserInput}
                                placeholder="まな先生にメッセージを送る..."
                                multiline
                            />
                            <TouchableOpacity style={styles.sendButton} onPress={handleSendMessage}><Ionicons name="send" size={24} color="white" /></TouchableOpacity>
                        </View>
                    </View>
                </KeyboardAvoidingView>
            </Modal>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#FFF8F0' },
    scrollContainer: { paddingBottom: 20 },
    planningActionContainer: { marginHorizontal: 16, marginVertical: 20, gap: 12 },
    planningButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FF6347', paddingVertical: 16, borderRadius: 16, shadowColor: '#FF6347', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 5, elevation: 8 },
    planningButtonText: { color: 'white', fontSize: 18, fontWeight: 'bold', marginLeft: 12 },
    viewPlansButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0F4F8', paddingVertical: 16, borderRadius: 16, borderWidth: 1, borderColor: '#E0E0E0' },
    processingButton: { backgroundColor: '#E0E7FF' },
    completedButton: { backgroundColor: '#22C55E', borderColor: '#16A34A' },
    errorButton: { backgroundColor: '#FFE9E9', borderColor: '#F5A3A3' },
    viewPlansButtonText: { fontSize: 18, fontWeight: 'bold' },
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
    modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
    modalBackdrop: { ...StyleSheet.absoluteFillObject },
    chatModalContent: { height: '90%', width: '100%', backgroundColor: '#F0F4F8', position: 'absolute', bottom: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
    messageBubble: { padding: 12, borderRadius: 18, marginBottom: 10, maxWidth: '80%' },
    userBubble: { backgroundColor: '#C9F0FF', alignSelf: 'flex-end', borderBottomRightRadius: 4 },
    modelBubble: { backgroundColor: '#FFFFFF', alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
    messageText: { fontSize: 16, lineHeight: 22 },
    inputContainer: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: '#ddd', padding: 8, backgroundColor: '#fff' },
    chatInput: { flex: 1, backgroundColor: '#fff', borderRadius: 22, paddingHorizontal: 15, paddingVertical: Platform.OS === 'ios' ? 12 : 8, fontSize: 16, maxHeight: 100 },
    sendButton: { marginLeft: 8, backgroundColor: '#6C63FF', borderRadius: 22, width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
    banner: { 
        borderWidth: 1, borderRadius: 10, marginHorizontal: 16, marginTop: 8, marginBottom: 0,
        paddingVertical: 10, paddingHorizontal: 12,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'
    },
    bannerText: { fontSize: 13, color: '#333', marginRight: 8 },
    bannerButton: { backgroundColor: '#FF6347', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
    bannerButtonText: { color: '#fff', fontWeight: '600', fontSize: 12 },
});
