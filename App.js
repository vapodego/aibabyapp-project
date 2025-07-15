import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, KeyboardAvoidingView, Platform, ImageBackground } from 'react-native';

const callMoonshot = async (prompt) => {
  try {
    console.log('[Moonshot呼び出し]', prompt);
    const res = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer sk-aQ25cqdGil3eIOmyRt6l4VJiOHwcmx1is1oC4gi8gc6ydFNh',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'moonshot-v1-8k',
        messages: [
          { role: 'system', content: 'あなたは優しく頼れる育児AIキャラです。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        max_tokens: 1000,
      }),
    });

    // ✅ レスポンスステータスチェック
    console.log('[Moonshotステータス]', res.status);
    if (!res.ok) {
      const text = await res.text();  // 失敗時はtextで確認
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
  const [messages, setMessages] = useState([{ sender: 'bot', text: 'こんにちは！育児AIへようこそ🌱' }]);
  const [input, setInput] = useState('');

 const handleSend = async () => {
  if (input.trim() === '') return;

  const newMessage = { sender: 'user', text: input };
  setMessages([...messages, newMessage]);
  setInput('');

  try {
    const botReply = await callMoonshot(input);
    setMessages(prev => [...prev, { sender: 'bot', text: botReply }]);
  } catch (error) {
    console.error('Moonshot APIエラー:', error);
    setMessages(prev => [...prev, { sender: 'bot', text: 'エラーが発生しました😢' }]);
  }
};



  return (
<KeyboardAvoidingView
  behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
  keyboardVerticalOffset={60}
  style={styles.container}
>
  <ImageBackground
    source={require('./assets/mana.png')} // 👈 画像ファイルを置く場所
    style={styles.background}
    resizeMode="cover"
  >
    <ScrollView
      style={styles.chatArea}
      contentContainerStyle={{ paddingBottom: 20 }}
      keyboardShouldPersistTaps="handled"
    >
      {messages.map((msg, index) => (
        <View key={index} style={[styles.message, msg.sender === 'user' ? styles.user : styles.bot]}>
          <Text style={styles.messageText}>{msg.text}</Text>
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
    marginBottom: 20, // 👈 追加！必要に応じて数値調整
  } ,
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
