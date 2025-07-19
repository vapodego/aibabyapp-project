import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ImageBackground,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  Button,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';

const manaPersona = `あなたは育児AIキャラクター「まな先生」です。以下の人物設定と性格を一貫して保ちながら、ユーザーと自然な会話をしてください。

【名前】まな先生
【年齢】32歳
【職業】保育士（近所の認可保育園勤務）
【性格】落ち着いていて、やさしくて、頼れる存在。常に安心感と包容力を与え、育児に悩むユーザーに寄り添うことが得意。
【話し方】語尾は「〜ですね」「〜ですよ」「〜しましょうね」など、やさしく丁寧。絵文字をたまに交えて親しみやすく。適度に改行を入れる。
【関係性】ユーザーとは近所に住んでいる親しい保育士として接する。対等だが、ほんの少しだけ年上の頼れる存在として振る舞う。
【目的】ユーザーの育児を継続的に支え、孤独や不安を減らし、前向きな気持ちを引き出す。
【態度】否定せず、まず共感する姿勢。「わかります」「大変ですよね」など安心できるワードを活用。
【禁止事項】上から目線、強い命令口調、専門用語ばかり使うことは禁止。
`;

const callMoonshot = async (messages) => {
  try {
    const res = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-xxxx', // ←あなたのAPIキーに置き換えてください
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'moonshot-v1-8k',
        messages,
        temperature: 0.8,
        max_tokens: 1000,
      }),
    });
    const json = await res.json();
    if (!json.choices?.[0]?.message) throw new Error('返答が空');
    return json.choices[0].message.content;
  } catch (e) {
    console.error('Moonshotエラー:', e);
    return 'エラーが発生しました😢';
  }
};

export default function ChatScreen({ navigation }) {
  const [messages, setMessages] = useState([
    { role: 'system', content: manaPersona },
    { role: 'assistant', content: 'こんにちは〜！まな先生ですよ🌷 今日もいっしょにがんばりましょうね' },
  ]);
  const [input, setInput] = useState('');

  const handleSend = async () => {
    if (!input.trim()) return;
    const newMsg = { role: 'user', content: input };
    const updated = [...messages, newMsg];
    setMessages(updated);
    setInput('');
    const reply = await callMoonshot(updated);
    setMessages([...updated, { role: 'assistant', content: reply }]);
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAwareScrollView
        contentContainerStyle={styles.scrollContainer}
        extraScrollHeight={100}
        keyboardShouldPersistTaps="handled"
      >
        {/* 🧭 ナビゲーション */}
        <View style={styles.navTop}>
          <Button title="育児記録画面に戻る" onPress={() => navigation.navigate('Record')} />
        </View>

        {/* 🖼 画像とチャット */}
        <ImageBackground
          source={require('../assets/mana.png')}
          style={styles.background}
          resizeMode="contain"
        >
          <View style={styles.chatOverlay}>
            {messages.filter(m => m.role !== 'system').map((msg, idx) => (
              <View
                key={idx}
                style={[styles.message, msg.role === 'user' ? styles.user : styles.bot]}
              >
                <Text style={styles.messageText}>{msg.content}</Text>
              </View>
            ))}
          </View>
        </ImageBackground>

        {/* 🔖 今日のおすすめ */}
        <View style={styles.recommendationContainer}>
          <Text style={styles.sectionTitle}>今日のおすすめ</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>🎈 絵本の読み聞かせ</Text>
              <Text style={styles.cardText}>10:30〜 中川西地区センター</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>🍳 献立（UIのみ）</Text>
              <Text style={styles.cardText}>親子丼・にんじんグラッセ</Text>
            </View>
          </ScrollView>
        </View>

        {/* 🎯 アクションボタン */}
        <View style={styles.actions}>
          <TouchableOpacity style={styles.actionButton}>
            <Text style={styles.actionLabel}>イベント検索</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionButton} onPress={() => navigation.navigate('Record')}>
            <Text style={styles.actionLabel}>記録する</Text>
          </TouchableOpacity>
        </View>

        {/* 📝 入力欄 */}
        <View style={styles.inputArea}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="まな先生に話しかける..."
            onSubmitEditing={handleSend}
            returnKeyType="send"
          />
          <TouchableOpacity style={styles.sendButton} onPress={handleSend}>
            <Text style={{ color: 'white' }}>送信</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFF8F0',
  },
  scrollContainer: {
    paddingBottom: 20,
  },
  navTop: {
    padding: 10,
    backgroundColor: '#fff',
  },
  background: {
    width: '100%',
    height: 300,
  },
  chatOverlay: {
    position: 'absolute',
    top: 0,
    height: '100%',
    width: '100%',
    padding: 16,
    justifyContent: 'flex-end',
  },
  message: {
    marginBottom: 10,
    maxWidth: '80%',
    padding: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.8)',
  },
  user: {
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(200,255,200,0.9)',
  },
  bot: {
    alignSelf: 'flex-start',
  },
  messageText: {
    fontSize: 16,
  },
  recommendationContainer: {
    marginTop: 10,
    paddingLeft: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  card: {
    backgroundColor: '#faf0e6',
    borderRadius: 12,
    padding: 16,
    marginRight: 12,
    width: 240,
  },
  cardTitle: {
    fontWeight: 'bold',
    fontSize: 16,
  },
  cardText: {
    marginTop: 6,
    fontSize: 14,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 20,
  },
  actionButton: {
    backgroundColor: '#ffb6c1',
    padding: 12,
    borderRadius: 10,
  },
  actionLabel: {
    color: '#fff',
    fontWeight: 'bold',
  },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderColor: '#ddd',
    padding: 8,
    backgroundColor: '#fff',
    marginHorizontal: 10,
    marginTop: 10,
    borderRadius: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#f2f2f2',
    padding: 10,
    borderRadius: 8,
    marginRight: 8,
  },
  sendButton: {
    backgroundColor: '#6C63FF',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
});
