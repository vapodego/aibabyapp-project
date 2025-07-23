import AsyncStorage from '@react-native-async-storage/async-storage';

// childcare_records_1year.json ファイルをインポート
// ファイルをプロジェクトのルートディレクトリにある 'assets/data' フォルダに配置してください
const sampleData = require('../assets/data/childcare_records_1year.json'); 

export const loadInitialRecords = async () => {
    try {
        const rawData = await AsyncStorage.getItem('records');
        if (!rawData || JSON.parse(rawData).length === 0) {
            // AsyncStorageが空の場合、または空配列の場合にのみサンプルデータを読み込む
            console.log("✅ AsyncStorageが空のため、初期サンプルデータを読み込み、保存します。");
            await AsyncStorage.setItem('records', JSON.stringify(sampleData));
        } else {
            console.log("✅ AsyncStorageに既存データがあるため、初期サンプルデータの読み込みはスキップされました。");
        }
    } catch (e) {
        console.error('❌ 初期データの読み込みまたは保存エラー:', e);
    }
};
