const WebSocket = require('ws');
const speech = require('@google-cloud/speech');
const fs = require('fs');
const { exec } = require('child_process'); // For running ffmpeg

// 🔑 あなたの Google Cloud JSON 鍵ファイルをここで指定
const speechClient = new speech.SpeechClient({
    keyFilename: './google-credentials.json',
});

const PORT = 8090;
const wss = new WebSocket.Server({ port: PORT, host: '0.0.0.0' });

console.log(`🟢 WebSocket サーバー起動中 (バッチ処理モード): ws://YOUR_MAC_IP:${PORT}`);
console.log('   (Androidエミュレーターからは ws://10.0.2.2:8090 で接続してください)');


wss.on('connection', (ws) => {
    console.log('🔗 クライアント接続');

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data && data.audio) {
                console.log('🏁 音声受信完了(base64)。処理を開始します。');
                
                const audioBuffer = Buffer.from(data.audio, 'base64');
                
                const tempInputPath = `./temp_audio_${Date.now()}.m4a`;
                const tempOutputPath = `./temp_audio_${Date.now()}.wav`;

                try {
                    fs.writeFileSync(tempInputPath, audioBuffer);
                    console.log(`🎧 音声ファイルを一時保存しました: ${tempInputPath}`);

                    await new Promise((resolve, reject) => {
                        console.log('🔄 FFmpegで音声形式を変換中...');
                        exec(`ffmpeg -i ${tempInputPath} -ar 16000 -ac 1 -c:a pcm_s16le ${tempOutputPath} -y`, (error, stdout, stderr) => {
                            if (error) {
                                console.error('FFmpegエラー:', stderr);
                                return reject(new Error('音声ファイルの変換に失敗しました。'));
                            }
                            console.log('✅ 音声変換完了:', tempOutputPath);
                            resolve();
                        });
                    });

                    console.log('🗣️ Google Cloud Speechで文字起こし中...');
                    const audioBytes = fs.readFileSync(tempOutputPath).toString('base64');
                    const audio = { content: audioBytes };
                    const config = {
                        encoding: 'LINEAR16',
                        sampleRateHertz: 16000,
                        languageCode: 'ja-JP',
                    };
                    const request = { audio: audio, config: config };

                    const [response] = await speechClient.recognize(request);
                    const transcription = response.results
                        .map(result => result.alternatives[0].transcript)
                        .join('\n');
                    
                    if (transcription) {
                        console.log('📝 認識結果:', transcription);
                        ws.send(JSON.stringify({ text: transcription }));
                    } else {
                        console.log('文字起こし結果がありませんでした。');
                        ws.send(JSON.stringify({ error: '音声を認識できませんでした。' }));
                    }

                } catch (error) {
                    console.error('音声処理全体でエラーが発生しました:', error);
                    ws.send(JSON.stringify({ error: 'サーバーでエラーが発生しました。' }));
                } finally {
                    // ★★★ デバッグのための変更点 ★★★
                    // 一時ファイルを削除する処理をコメントアウトし、音声ファイルが残るようにします。
                    if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
                    // if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath); // wavファイルを残す
                    console.log(`🧹 一時ファイルをクリーンアップしました。(デバッグのため ${tempOutputPath} は残っています)`);
                    console.log(`   Finderでこのファイルを開いて、音声が録音されているか確認してください。`);
                }
            } else {
                console.log('受信データに音声情報が含まれていませんでした。');
            }
        } catch(e) {
            console.error("受信メッセージの処理エラー(JSONパース失敗など):", e);
        }
    });

    ws.on('close', () => {
        console.log('❌ クライアント切断');
    });

    ws.on('error', (error) => {
        console.error('WebSocketエラー:', error);
    });
});
