import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Image, TouchableOpacity, RefreshControl, ActivityIndicator, TextInput, Alert, Modal } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';

// Firebase v9 modular
import { getApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, orderBy, limit, startAfter } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';

const PAGE_SIZE = 20;

export default function ArticleHubScreen() {
  const navigation = useNavigation();
  const route = useRoute();

  // Optional: monthAge を route から受け取る（将来プロフィール連動）
  const monthAge = route?.params?.month ?? null;

  const [recommended, setRecommended] = useState([]); // 上段3件
  const [articles, setArticles] = useState([]);       // 一覧（ページング）
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [showComposer, setShowComposer] = useState(false);
  const [composeTopic, setComposeTopic] = useState('');
  const [composeMonthAge, setComposeMonthAge] = useState(''); // string → parseInt
  const [composeTags, setComposeTags] = useState(''); // カンマ区切り
  const lastDocRef = useRef(null);

  const db = useMemo(() => getFirestore(getApp()), []);
  const functions = useMemo(() => getFunctions(getApp(), 'asia-northeast1'), []);

  const toMillis = (ts) => {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts?.toMillis === 'function') return ts.toMillis();
    try { return new Date(ts).getTime() || 0; } catch { return 0; }
  };

  const filteredArticles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return articles;
    return articles.filter(a => (a?.title || '').toLowerCase().includes(q));
  }, [articles, search]);

  const { recentCount, totalCount, lastUpdatedText } = useMemo(() => {
    const now = Date.now();
    const THIRTY_D = 30 * 24 * 60 * 60 * 1000;
    const total = articles.length;
    let recent = 0;
    let latest = 0;
    for (const a of articles) {
      const ms = toMillis(a?.createdAt);
      if (ms) {
        if (now - ms <= THIRTY_D) recent += 1;
        if (ms > latest) latest = ms;
      }
    }
    const lastTxt = latest ? new Date(latest).toLocaleDateString() : '—';
    return { recentCount: recent, totalCount: total, lastUpdatedText: lastTxt };
  }, [articles]);

  const fetchRecommended = useCallback(async () => {
    // MVP: createdAt desc で 3件。将来は monthAge / tags でブースト
    const q = query(collection(db, 'articles'), orderBy('createdAt', 'desc'), limit(3));
    const snap = await getDocs(q);
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setRecommended(rows);
  }, [db]);

  const fetchFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      await fetchRecommended();
      const q = query(collection(db, 'articles'), orderBy('createdAt', 'desc'), limit(PAGE_SIZE));
      const snap = await getDocs(q);
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setArticles(rows);
      lastDocRef.current = snap.docs[snap.docs.length - 1] || null;
    } finally {
      setLoading(false);
    }
  }, [db, fetchRecommended]);

  const fetchNextPage = useCallback(async () => {
    if (!lastDocRef.current || loadingMore) return;
    setLoadingMore(true);
    try {
      const q = query(
        collection(db, 'articles'),
        orderBy('createdAt', 'desc'),
        startAfter(lastDocRef.current),
        limit(PAGE_SIZE)
      );
      const snap = await getDocs(q);
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setArticles(prev => [...prev, ...rows]);
      lastDocRef.current = snap.docs[snap.docs.length - 1] || null;
    } finally {
      setLoadingMore(false);
    }
  }, [db, loadingMore]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchFirstPage();
    setRefreshing(false);
  }, [fetchFirstPage]);

  useEffect(() => {
    fetchFirstPage();
  }, [fetchFirstPage]);

  const handleSubmitCompose = useCallback(async () => {
    try {
      const monthAge = parseInt(composeMonthAge, 10);
      const tags = composeTags.split(',').map(t => t.trim()).filter(Boolean);
      const payload = { topic: composeTopic.trim(), monthAge: isNaN(monthAge) ? null : monthAge, tags };

      if (!payload.topic) {
        Alert.alert('入力不足', 'トピック（作成したい記事のテーマ）を入力してください。');
        return;
      }

      // callable: requestArticleCreation（未実装ならcatchに落ちる→メッセージ）
      const requestArticleCreation = httpsCallable(functions, 'requestArticleCreation');
      const res = await requestArticleCreation(payload);
      setShowComposer(false);
      setComposeTopic(''); setComposeMonthAge(''); setComposeTags('');
      Alert.alert('受付しました', '記事の作成を開始しました。数分後にこの画面に反映されます。');
    } catch (e) {
      console.warn('[ArticleHub] requestArticleCreation failed or not deployed:', e);
      Alert.alert('未対応', 'サーバ側の記事作成エンドポイントが未設定です。先に Functions: requestArticleCreation をデプロイしてください。');
    }
  }, [composeTopic, composeMonthAge, composeTags, functions]);

  const renderCard = useCallback((item, isHero = false) => {
    const img = item?.image?.url;

    if (isHero) {
      // 大きめカード（おすすめ）：従来どおり
      return (
        <TouchableOpacity
          key={item.id}
          style={[styles.card, styles.heroCard]}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('MonthlyArticle', { articleId: item.id })}
        >
          {img ? (
            <Image source={{ uri: img }} style={styles.cardImage} resizeMode="cover" />
          ) : (
            <View style={styles.cardImagePlaceholder}><Text style={styles.phIcon}>📖</Text></View>
          )}
          <View style={styles.cardContent}>
            <Text numberOfLines={2} style={styles.cardTitle}>{item.title || '無題の記事'}</Text>
            <Text numberOfLines={1} style={styles.cardSub}>
              {item.monthAge != null ? `生後${item.monthAge}か月` : '記事'}
              {item.tags?.length ? ` ・ ${item.tags[0]}` : ''}
            </Text>
          </View>
        </TouchableOpacity>
      );
    }

    // コンパクト行（一覧）：左に小さなサムネ、右にテキスト
    return (
      <TouchableOpacity
        key={item.id}
        style={styles.compactRow}
        activeOpacity={0.8}
        onPress={() => navigation.navigate('MonthlyArticle', { articleId: item.id })}
      >
        {img ? (
          <Image source={{ uri: img }} style={styles.thumb} resizeMode="cover" />
        ) : (
          <View style={styles.thumbPlaceholder}><Text style={styles.phIconMini}>📖</Text></View>
        )}
        <View style={styles.compactContent}>
          <Text numberOfLines={2} style={styles.compactTitle}>{item.title || '無題の記事'}</Text>
          <View style={styles.metaRow}>
            {item.monthAge != null && (
              <View style={styles.pill}><Text style={styles.pillText}>生後{item.monthAge}か月</Text></View>
            )}
            {!!(item.tags && item.tags.length) && (
              <View style={styles.pill}><Text style={styles.pillText}>{item.tags[0]}</Text></View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  }, [navigation]);

  const ListHeader = useMemo(() => (
    <View style={styles.headerWrap}>
      {/* 上部スペース＋ユーティリティバー */}
      <View style={styles.topSpacer} />
      <View style={styles.toolbar}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="記事を検索（タイトル）"
          placeholderTextColor="#9BA0A6"
          style={styles.searchInput}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {/* ステータスサマリー＋作成ボタン */}
      <View style={styles.summaryCard}>
        <View style={styles.summaryStats}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>今月の新着</Text>
            <Text style={styles.summaryValue}>{recentCount}</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>合計</Text>
            <Text style={styles.summaryValue}>{totalCount}</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>最終更新</Text>
            <Text style={styles.summaryValueSmall}>{lastUpdatedText}</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.composeBtn} activeOpacity={0.85} onPress={() => setShowComposer(true)}>
          <Text style={styles.composeBtnText}>＋ 記事を作成</Text>
        </TouchableOpacity>
      </View>

      {/* おすすめセクション */}
      <Text style={styles.sectionTitle}>🆕 今日のおすすめ</Text>
      <View style={styles.recoWrap}>
        {recommended.length > 0 ? (
          <FlatList
            data={recommended}
            keyExtractor={(it) => it.id}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingRight: 8 }}
            ItemSeparatorComponent={() => <View style={{ width: 12 }} />}
            renderItem={({ item }) => (
              <View style={{ width: 300 }}>{renderCard(item, true)}</View>
            )}
          />
        ) : (
          <Text style={styles.emptyText}>おすすめ記事がまだありません</Text>
        )}
      </View>

      <Text style={[styles.sectionTitle, { marginTop: 8 }]}>📚 記事一覧</Text>
    </View>
  ), [recommended, renderCard, search, recentCount, totalCount, lastUpdatedText]);

  if (loading && !articles.length) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator />
        <Text style={{ marginTop: 8 }}>読み込み中…</Text>
      </View>
    );
  }

  {/* 記事作成モーダル */}
  return (
    <>
      <Modal transparent visible={showComposer} animationType="slide" onRequestClose={() => setShowComposer(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>新しい記事を依頼</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="トピック（例：6〜8か月の離乳食ステップ）"
              placeholderTextColor="#9BA0A6"
              value={composeTopic}
              onChangeText={setComposeTopic}
            />
            <TextInput
              style={styles.modalInput}
              placeholder="対象月齢（数値, 任意）"
              placeholderTextColor="#9BA0A6"
              keyboardType="number-pad"
              value={composeMonthAge}
              onChangeText={setComposeMonthAge}
            />
            <TextInput
              style={styles.modalInput}
              placeholder="タグ（カンマ区切り, 任意）例: 睡眠, 離乳食"
              placeholderTextColor="#9BA0A6"
              value={composeTags}
              onChangeText={setComposeTags}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalCancel]} onPress={() => setShowComposer(false)}>
                <Text style={styles.modalBtnTextCancel}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalSubmit]} onPress={handleSubmitCompose}>
                <Text style={styles.modalBtnTextSubmit}>作成を依頼</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <FlatList
        data={filteredArticles}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={ListHeader}
        renderItem={({ item }) => renderCard(item)}
        contentContainerStyle={styles.listContent}
        onEndReachedThreshold={0.2}
        onEndReached={fetchNextPage}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ marginVertical: 16 }} /> : null}
      />
    </>
  );
}

const styles = StyleSheet.create({
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingBottom: 24 },
  section: { paddingHorizontal: 16, paddingTop: 12 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#333', marginBottom: 8 },
  recoWrap: { gap: 12, marginBottom: 8, paddingVertical: 4 },
  heroCard: {},
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e5e5',
  },
  cardImage: { width: '100%', height: 160, backgroundColor: '#f5f5f5' },
  cardImagePlaceholder: { width: '100%', height: 160, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f5f5f5' },
  phIcon: { fontSize: 28 },
  cardContent: { padding: 12 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: '#222', marginBottom: 4 },
  cardSub: { fontSize: 13, color: '#666' },

  // 追加: コンパクト行（一覧）用
  compactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ececec',
    gap: 12,
  },
  thumb: { width: 72, height: 72, borderRadius: 8, backgroundColor: '#f2f2f2' },
  thumbPlaceholder: {
    width: 72,
    height: 72,
    borderRadius: 8,
    backgroundColor: '#f2f2f2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  phIconMini: { fontSize: 20 },
  compactContent: { flex: 1, minHeight: 72, justifyContent: 'center' },
  compactTitle: { fontSize: 15, fontWeight: '700', color: '#222' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  pill: { paddingHorizontal: 8, paddingVertical: 3, backgroundColor: '#F1F1F5', borderRadius: 999 },
  pillText: { fontSize: 12, color: '#555' },

  headerWrap: { paddingHorizontal: 16, paddingTop: 0 },
  topSpacer: { height: 16 },
  toolbar: { marginBottom: 8 },
  searchInput: {
    height: 40,
    borderRadius: 10,
    backgroundColor: '#F1F3F5',
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#222',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E7EB',
  },

  summaryCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E7EB',
  },
  summaryStats: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryLabel: { fontSize: 12, color: '#6B7280' },
  summaryValue: { fontSize: 18, fontWeight: '800', color: '#111827' },
  summaryValueSmall: { fontSize: 13, fontWeight: '700', color: '#111827' },
  summaryDivider: { width: 1, height: 24, backgroundColor: '#E5E7EB' },
  composeBtn: {
    alignSelf: 'flex-end',
    backgroundColor: '#6C63FF',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  composeBtnText: { color: 'white', fontWeight: '700' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: '#fff', borderRadius: 12, padding: 16 },
  modalTitle: { fontSize: 16, fontWeight: '800', marginBottom: 12, color: '#111' },
  modalInput: {
    height: 42,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#222',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E7EB',
    marginBottom: 10,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4 },
  modalBtn: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  modalCancel: { backgroundColor: '#EFEFEF', marginRight: 8 },
  modalSubmit: { backgroundColor: '#6C63FF' },
  modalBtnTextCancel: { color: '#374151', fontWeight: '700' },
  modalBtnTextSubmit: { color: '#fff', fontWeight: '700' },
});