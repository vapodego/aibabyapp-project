import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, SafeAreaView, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl, Linking } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { getAuth } from 'firebase/auth';

// ★ Cloud Functions Gen2: getPlanHistory エンドポイント
//   必要に応じて projectId / region を環境に合わせて変更してください。
const REGION = 'asia-northeast1';
const PROJECT_ID = 'aibabyapp-abeae';

const CF_HISTORY_URL = (userId) =>
  `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/getPlanHistory?userId=${encodeURIComponent(userId)}`;

export default function PlanHistoryScreen() {
  const navigation = useNavigation();
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const fetchHistory = async () => {
    setErrorMsg('');
    try {
      // 認証中のユーザーを優先（未ログインならフォールバックを許容）
      const auth = getAuth();
      const uid = auth.currentUser?.uid;
      if (!uid) {
        throw new Error('ユーザーが未ログインです。');
      }

      const resp = await fetch(CF_HISTORY_URL(uid), { method: 'GET' });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${t || 'unknown error'}`);
      }
      const json = await resp.json();
      const list = Array.isArray(json?.history) ? json.history : [];

      // createdAt 降順に並べ替え（Firestore Timestamp / ISO / number に対応）
      list.sort((a, b) => tsToMs(b?.createdAt) - tsToMs(a?.createdAt));
      setPlans(list);
    } catch (e) {
      console.error('[PlanHistoryScreen] fetch error', e);
      setErrorMsg('履歴の取得に失敗しました。ログイン状態やネットワークをご確認ください。');
      setPlans([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // 画面初回／復帰時に更新
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchHistory();
    }, [])
  );

  const onRefresh = () => {
    setRefreshing(true);
    fetchHistory();
  };

  const openPreview = async (item) => {
    // 優先: previewUrl（関数が返すプレビュー）
    if (item?.previewUrl) {
      try {
        await Linking.openURL(item.previewUrl);
        return;
      } catch (e) {
        console.warn('Failed to open previewUrl', e);
      }
    }
  };

  const renderItem = ({ item }) => {
    const createdAtMs = tsToMs(item?.createdAt);
    const createdAtText = createdAtMs ? new Date(createdAtMs).toLocaleString() : '日時不明';

    // 行全体をタップで、その runId の提案一覧へ遷移
    const goToRun = () => navigation.navigate('SuggestedPlans', { runId: item.runId || item.id });

    return (
      <TouchableOpacity style={styles.itemContainer} onPress={goToRun} accessibilityRole="button">
        <Text style={styles.itemDate}>{createdAtText}</Text>
        <Text style={styles.itemMeta} numberOfLines={2}>
          条件: {Array.isArray(item?.interests) ? item.interests.join(', ') : 'なし'}
          {item?.area ? ` / エリア: ${item.area}` : ''}
          {item?.maxResults ? ` / 最大件数: ${item.maxResults}` : ''}
        </Text>
        {typeof item?.suggestedCount === 'number' && (
          <Text style={styles.itemMeta}>生成候補: {item.suggestedCount}件</Text>
        )}
        <Text style={[styles.badge, badgeColor(item.status)]}>{statusLabel(item.status)}</Text>

        {/* プレビューがある場合のみ副作用ボタンを表示 */}
        {item?.previewUrl ? (
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation(); openPreview(item); }}
            accessibilityRole="button"
            style={styles.linkBtn}
          >
            <Text style={styles.linkText}>プレビューを開く</Text>
          </TouchableOpacity>
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" />
          <Text style={styles.centerText}>読み込み中...</Text>
        </View>
      ) : (
        <>
          {!!errorMsg && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{errorMsg}</Text>
            </View>
          )}
          <FlatList
            data={plans}
            keyExtractor={(item, idx) => item?.runId || item?.id || String(idx)}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            ListEmptyComponent={
              <View style={styles.centerBox}>
                <Text style={styles.centerText}>履歴がありません</Text>
              </View>
            }
          />
        </>
      )}
    </SafeAreaView>
  );
}

// --- helpers ---

function tsToMs(ts) {
  if (!ts) return 0;
  // Firestore Timestamp { seconds, nanoseconds }
  if (typeof ts === 'object' && typeof ts.seconds === 'number') {
    return ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0) / 1e6);
  }
  // ISO文字列 or 数値ミリ秒
  if (typeof ts === 'string') {
    const t = Date.parse(ts);
    return isNaN(t) ? 0 : t;
  }
  if (typeof ts === 'number') {
    // 10桁秒 → 13桁ミリ秒へ
    return ts < 2e10 ? ts * 1000 : ts;
  }
  return 0;
}

function statusLabel(s) {
  switch ((s || '').toLowerCase()) {
    case 'inprogress':
    case 'running':
      return '進行中';
    case 'completed':
    case 'done':
      return '完了';
    case 'error':
    case 'failed':
      return 'エラー';
    default:
      return s || 'unknown';
  }
}

function badgeColor(s) {
  const base = { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, alignSelf: 'flex-start', marginTop: 6 };
  switch ((s || '').toLowerCase()) {
    case 'completed':
    case 'done':
      return { ...base, backgroundColor: '#e7f8ec', borderColor: '#2ecc71', borderWidth: 1, color: '#2ecc71' };
    case 'inprogress':
    case 'running':
      return { ...base, backgroundColor: '#eef4ff', borderColor: '#4c78ff', borderWidth: 1, color: '#4c78ff' };
    case 'error':
    case 'failed':
      return { ...base, backgroundColor: '#fdeced', borderColor: '#e74c3c', borderWidth: 1, color: '#e74c3c' };
    default:
      return { ...base, backgroundColor: '#eee', borderColor: '#ccc', borderWidth: 1, color: '#444' };
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  listContent: { padding: 16 },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centerText: { marginTop: 8, color: '#333' },
  errorBox: { backgroundColor: '#fdeced', padding: 12, margin: 12, borderRadius: 8, borderWidth: 1, borderColor: '#f5b1b5' },
  errorText: { color: '#c0392b' },

  itemContainer: { backgroundColor: '#f7f8fa', borderRadius: 10, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#e6e8eb' },
  itemDate: { fontSize: 16, fontWeight: 'bold', marginBottom: 6, color: '#111' },
  itemMeta: { fontSize: 13, color: '#555', marginBottom: 2 },
  badge: { fontSize: 12, fontWeight: '600' },

  linkBtn: { marginTop: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#007AFF', alignSelf: 'flex-start' },
  linkText: { color: '#007AFF', fontSize: 14, fontWeight: '600' },
});