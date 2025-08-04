/**
 * =================================================================
 * Agentモード・バックエンド (agentMode.js) - 最終診断ツール版
 * =================================================================
 * - Expoサーバーから予期せぬHTMLが返ってくる問題の原因を特定するため、
 * テスト関数に詳細なエラーハンドリングと診断ログを追加しました。
 * - JSONの解析に失敗した場合、受信した生のテキストをログに出力します。
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require('node-fetch');

if (process.env.FUNCTIONS_EMULATOR === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/**
 * [Task 1-2] 通知実行エンジン
 */
exports.agentNotificationTrigger = functions
  .region("asia-northeast1")
  .pubsub.schedule("every 1 minutes")
  .onRun(async (context) => {
    // ... (この関数は変更なし)
  });

/**
 * [Task 1-3] プッシュ通知機能
 */
async function sendPushNotification(userId, notification) {
  // ... (この関数は変更なし)
}


/**
 * curlで呼び出すためのテスト用関数
 */
exports.sendTestNotification = functions
  .region("asia-northeast1")
  .https.onRequest(async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    try {
      const { token, title, body } = req.body.data;

      if (!token || !title || !body) {
        res.status(400).send('token, title, body are required.');
        return;
      }

      const message = {
        to: token,
        sound: 'default',
        title: title,
        body: body,
      };

      console.log("テスト通知を送信します:", message);

      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });
      
      // ▼▼▼【診断機能】ここから修正 ▼▼▼
      const responseText = await response.text(); // まずはテキストとして応答を取得

      try {
        const responseData = JSON.parse(responseText); // JSONとして解析を試みる
        console.log("Expoからの正常な応答(JSON):", responseData);
        res.status(200).send({ success: true, response: responseData });
      } catch (e) {
        // JSON解析に失敗した場合、それはHTMLである可能性が高い
        console.error("ExpoからJSONではない応答を受信しました。これはネットワークの傍受が原因である可能性が高いです。");
        console.log("--- 受信した生の応答テキスト BEGIN ---");
        console.log(responseText);
        console.log("--- 受信した生の応答テキスト END ---");
        res.status(500).send({ 
            success: false, 
            error: "Received an invalid (non-JSON) response from Expo server. Check logs for details.",
            rawResponse: responseText,
        });
      }
      // ▲▲▲【ここまで】▲▲▲

    } catch (error) {
      console.error("テスト通知の送信中にエラー:", error);
      res.status(500).send({ success: false, error: error.message });
    }
  });
