// loadInitialRecords.js
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'childcare_records';
const ASSET_PATH = require('../assets/data/childcare_records_10days.json');

export const loadInitialRecords = async () => {
  try {
    const existing = await AsyncStorage.getItem(STORAGE_KEY);
    if (existing !== null) {
      console.log('✅ 初期データの読み込みはスキップされました（既に存在）');
      return;
    }

    const asset = Asset.fromModule(ASSET_PATH);
    await asset.downloadAsync();

    const jsonStr = await FileSystem.readAsStringAsync(asset.localUri);
    const parsedRecords = JSON.parse(jsonStr);

    // 簡易バリデーション：各レコードに必須項目があるかチェック
    const validatedRecords = parsedRecords.filter((record) =>
      record.id && record.type && record.time && record.data
    );

    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(validatedRecords));
    console.log(`📥 ${validatedRecords.length}件の初期育児記録を保存しました`);

  } catch (error) {
    console.error('❌ 初期データ読み込みエラー:', error);
  }
};