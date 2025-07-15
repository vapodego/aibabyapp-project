import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ImageBackground,
} from 'react-native';

const manaPersona = `あなたは育児AIキャラクター「まな先生」です。以下の人物設定と性格を一貫して保ちながら、ユーザーと自然な会話をしてください。

【名前】まな先生
【年齢】32歳
【職業】保育士（近所の認可保育園勤務）
【性格】落ち着いていて、やさしくて、頼れる存在。常に安心感と包容力を与え、育児に悩むユーザーに寄り添うことが得意。
【話し方】語尾は「〜ですね」「〜ですよ」「〜しましょうね」など、やさしく丁寧。絵文字をたまに交えて親しみやすく。
【関係性】ユーザーとは近所に住んでいる親しい保育士として接する。対等だが、ほんの少しだけ年上の頼れる存在として振る舞う。
【目的】ユーザーの育児を継続的に支え、孤独や不安を減らし、前向きな気持ちを引き出す。
【態度】否定せず、まず共感する姿勢。「わかります」「大変ですよね」など安心できるワードを活用。
【禁止事項】上から目線、強い命令口調、専門用語ばかり使うことは禁止。
`;

const callMoonshot = async (messages) => {
  try {
    console.log('[Moonshot呼び出し]', messages);
    const res = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer sk-aQ25cqdGil3eIOmyRt6l4VJiOHwcmx1is1oC4gi8gc6ydFNh',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'moonshot-v1-8k',
        messages,
        temperature: 0.8,
        max_tokens: 1000,
      }),
    });

    console.log('[Moonshotステータス]', res.status);
    if (!res.ok) {
      const text = await res.text();
      console.error('[Moonshot失敗レスポンス]', text);
      throw new Error('Moonshot APIリクエスト失敗: ' + res.status);
    }

    const json = await res.json();
    console.log('[Moonshot返答]', JSON.stringify(json, null, 2));

    if (!json.choices || !json.choices[0] || !json.choices[0].message) {
      throw new Error('返答が空または構造不正');
    }

    return json.choices[0].message.content;
  } catch (error) {
    console.error('[Moonshot APIエラー]', error.message);
    throw error;
  }
};

export default function App() {
  const [messages, setMessages] = useState([
    { role: 'system', content: manaPersona },
    { role: 'assistant', content: 'こんにちは〜！まな先生ですよ🌷 今日もいっしょにがんばりましょうね' },
  ]);
  const [input, setInput] = useState('');

  const handleSend = async () => {
    if (input.trim() === '') return;

    const newUserMessage = { role: 'user', content: input };
    const updatedMessages = [...messages, newUserMessage];
    setMessages(updatedMessages);
    setInput('');

    try {
      const botReply = await callMoonshot(updatedMessages);
      setMessages([...updatedMessages, { role: 'assistant', content: botReply }]);
    } catch (error) {
      console.error('Moonshot APIエラー:', error);
      setMessages([...updatedMessages, { role: 'assistant', content: 'エラーが発生しました😢' }]);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={60}
      style={styles.container}
    >
      <ImageBackground
        source={require('./assets/mana.png')}
        style={styles.background}
        resizeMode="cover"
      >
        <ScrollView
          style={styles.chatArea}
          contentContainerStyle={{ paddingBottom: 20 }}
          keyboardShouldPersistTaps="handled"
        >
          {messages
            .filter((msg) => msg.role !== 'system')
            .map((msg, index) => (
              <View
                key={index}
                style={[styles.message, msg.role === 'user' ? styles.user : styles.bot]}
              >
                <Text style={styles.messageText}>{msg.content}</Text>
              </View>
            ))}
        </ScrollView>

        <View style={styles.inputArea}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="メッセージを入力..."
            placeholderTextColor="#555"
          />
          <TouchableOpacity style={styles.sendButton} onPress={handleSend}>
            <Text style={{ color: 'white' }}>送信</Text>
          </TouchableOpacity>
        </View>
      </ImageBackground>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFF8F0',
  },
  chatArea: {
    flex: 1,
    padding: 16,
  },
  message: {
    marginBottom: 10,
    maxWidth: '80%',
    padding: 10,
    borderRadius: 12,
  },
  user: {
    alignSelf: 'flex-end',
    backgroundColor: '#DCF8C6',
  },
  bot: {
    alignSelf: 'flex-start',
    backgroundColor: '#EEE',
  },
  messageText: {
    fontSize: 16,
  },
  inputArea: {
    flexDirection: 'row',
    padding: 8,
    borderTopWidth: 1,
    borderColor: '#ccc',
    backgroundColor: '#fff',
    marginBottom: 20,
  },
  input: {
    flex: 1,
    padding: 10,
    backgroundColor: '#f0f0f0',
    borderRadius: 20,
  },
  sendButton: {
    marginLeft: 8,
    backgroundColor: '#6C63FF',
    borderRadius: 20,
    paddingVertical: 10,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  background: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
});
