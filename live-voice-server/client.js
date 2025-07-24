// client.js
const fs = require('fs');
const WebSocket = require('ws');

const filePath = './test.wav'; // ここが変換後のWAVファイル名

const ws = new WebSocket('ws://localhost:8090');

ws.on('open', () => {
  console.log('📡 接続成功。音声ファイルを送信します…');

  const stream = fs.createReadStream(filePath, { highWaterMark: 3200 }); // 100msごとに送る

  stream.on('data', (chunk) => {
    ws.send(chunk);
  });

  stream.on('end', () => {
    console.log('✅ 音声ファイルの送信が完了しました');
  });
});

ws.on('message', (data) => {
  try {
    const parsed = JSON.parse(data);
    if (parsed.text) {
      console.log('📝 認識結果:', parsed.text);
    } else if (parsed.error) {
      console.error('❌ エラー:', parsed.error);
    }
  } catch {
    console.log('📨 サーバーからのメッセージ:', data.toString());
  }
});
