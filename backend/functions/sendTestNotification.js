const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { Expo } = require("expo-server-sdk");

// Expoの初期化
const expo = new Expo();

exports.sendTestNotification = functions
  .region("asia-northeast1")
  .https.onRequest(async (req, res) => {
    // --- 1. Firestoreからテスト対象ユーザーの情報を取得 ---
    // 先ほどのログで確認した、あなたのユーザーIDをここに指定します。
    const testUserId = "aiJOSnmUIEZxZ2DUqUzOOjvtd982"; 
    
    console.log(`テスト通知をユーザーID: ${testUserId} に送信します。`);

    const userRef = admin.firestore().collection("users").doc(testUserId);
    let userDoc;
    try {
      userDoc = await userRef.get();
    } catch (error) {
      console.error("Firestoreからのユーザー取得に失敗:", error);
      res.status(500).send("Firestoreからのユーザー取得に失敗しました。");
      return;
    }

    if (!userDoc.exists) {
      console.error("ユーザーが見つかりません:", testUserId);
      res.status(404).send(`ユーザーID: ${testUserId} は見つかりませんでした。`);
      return;
    }

    const expoPushToken = userDoc.data()?.expoPushToken;

    if (!expoPushToken) {
      console.error("Pushトークンが見つかりません。");
      res.status(404).send("ユーザーに有効なPushトークンがありません。");
      return;
    }

    // --- 2. Push通知を送信 ---
    if (!Expo.isExpoPushToken(expoPushToken)) {
        console.error(`Pushトークンの形式が不正です: ${expoPushToken}`);
        res.status(400).send("Pushトークンの形式が正しくありません。");
        return;
    }

    const message = {
      to: expoPushToken,
      sound: "default",
      title: "🎉 テスト成功！",
      body: "バックエンドから通知を送信できました！",
      data: { withSome: "data" }, // 通知と共に追加データを送ることも可能
    };

    try {
      console.log("Expoサーバーへ通知を送信中...");
      const ticket = await expo.sendPushNotificationsAsync([message]);
      console.log("送信結果:", ticket);
      res.status(200).send(`通知を送信しました。チケット: ${JSON.stringify(ticket)}`);
    } catch (error) {
      console.error("通知の送信に失敗:", error);
      res.status(500).send("通知の送信中にエラーが発生しました。");
    }
  });
