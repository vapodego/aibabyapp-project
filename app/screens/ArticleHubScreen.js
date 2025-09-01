import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Image, TouchableOpacity, RefreshControl, ActivityIndicator, TextInput, Alert, Modal, Pressable, Animated } from 'react-native';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';

// Firebase v9 modular
import { getApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, orderBy, limit, startAfter, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getAuth } from 'firebase/auth';

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
  // モーダル: キーワード/要望のみ
  const [generating, setGenerating] = useState(new Set()); // articleId set while generating
  const [creating, setCreating] = useState(false); // 作成中インジケータ
  const [seeding, setSeeding] = useState(false);
  const handleGenerateSeeds = useCallback(async () => {
    if (seeding) return;
    setSeeding(true);
    try {
      const gen = httpsCallable(functions, 'generateMonthlyArticles');
      const res = await gen();
      const createdId = res?.data?.createdId;
      console.log('[ArticleHub] generated article id:', createdId);
      // ensure the new article appears in feeds for current user
      try {
        const uid = auth.currentUser?.uid;
        if (uid) {
          await fetch(`${CF_BASE}/deliverDailyFeeds?uid=${encodeURIComponent(uid)}&limit=5`);
        }
      } catch (e) { console.warn('[ArticleHub] auto-deliver after seed failed', e?.message || e); }
      await fetchRecommended();
      await fetchFirstPage();
      Alert.alert('生成完了', '記事を 1 件作成しました。');
    } catch (e) {
      console.warn('[ArticleHub] generateMonthlyArticles failed:', e);
      Alert.alert('生成エラー', String(e?.message || e));
    } finally {
      setSeeding(false);
    }
  }, [functions, fetchFirstPage, fetchRecommended, seeding, auth, CF_BASE]);
  const lastDocRef = useRef(null);

  const db = useMemo(() => getFirestore(getApp()), []);
  const auth = useMemo(() => getAuth(getApp()), []);
  const functions = useMemo(() => getFunctions(getApp(), 'asia-northeast1'), []);
  const CF_BASE = 'https://asia-northeast1-aibabyapp-abeae.cloudfunctions.net';

  // ヒーローのフェード設定（スクロールに応じて薄く）
  const scrollY = useRef(new Animated.Value(0)).current;
  const heroFadeRange = 140; // 調整ポイント: 早める=120/100, 遅らせる=160〜180
  const clampedY = Animated.diffClamp(scrollY, 0, heroFadeRange);
  const heroOpacity = clampedY.interpolate({ inputRange: [0, heroFadeRange], outputRange: [1, 0], extrapolate: 'clamp' });

  const withGenerating = (id, fn) => async () => {
    setGenerating(prev => new Set(prev).add(id));
    try { await fn(); }
    finally { setGenerating(prev => { const n = new Set(prev); n.delete(id); return n; }); }
  };

  // HTTP Functions: ensureArticleImage を直接叩いて記事の image を更新
  const ensureImage = useCallback(async (articleId, opts = { force: false }) => {
    try {
      const res = await fetch(`${CF_BASE}/ensureArticleImage${opts.force ? '?force=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '画像生成に失敗しました');
      // ローカル一覧とおすすめをpatch
      setArticles(prev => prev.map(a => (a.id === articleId ? { ...a, image: json.image } : a)));
      setRecommended(prev => prev.map(a => (a.id === articleId ? { ...a, image: json.image } : a)));
      return json;
    } catch (e) {
      console.warn('[ArticleHub] ensureImage error', e);
      Alert.alert('画像生成エラー', String(e?.message || e));
      throw e;
    }
  }, [CF_BASE]);

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
    const uid = auth.currentUser?.uid;
    if (!uid) {
      // fallback: latest articles when unauthenticated
      const q = query(collection(db, 'articles'), orderBy('createdAt', 'desc'), limit(3));
      const snap = await getDocs(q);
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data(), feed: null }));
      setRecommended(rows);
      return;
    }
    // use user's feeds: order by deliveredAt desc
    const feedsQ = query(collection(db, 'users', uid, 'articleFeeds'), orderBy('deliveredAt', 'desc'), limit(5));
    const feedSnap = await getDocs(feedsQ);
    if (feedSnap.empty) {
      // try auto-deliver; ignore error and fallback
      try {
        await fetch(`${CF_BASE}/deliverDailyFeeds?uid=${encodeURIComponent(uid)}&limit=3`);
        const again = await getDocs(feedsQ);
        if (!again.empty) {
          const items = [];
          for (const fd of again.docs) {
            const feed = { id: fd.id, ...fd.data() };
            const artRef = doc(db, 'articles', fd.id);
            const artSnap = await getDoc(artRef);
            if (artSnap.exists()) items.push({ id: artSnap.id, ...artSnap.data(), feed });
          }
          setRecommended(items);
          return;
        }
      } catch (_) {}
      // fallback to latest 3
      const q = query(collection(db, 'articles'), orderBy('createdAt', 'desc'), limit(3));
      const snap = await getDocs(q);
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data(), feed: null }));
      setRecommended(rows);
      return;
    }
    const items = [];
    for (const fd of feedSnap.docs) {
      const feed = { id: fd.id, ...fd.data() };
      const artRef = doc(db, 'articles', fd.id);
      const artSnap = await getDoc(artRef);
      if (artSnap.exists()) items.push({ id: artSnap.id, ...artSnap.data(), feed });
    }
    setRecommended(items);
  }, [db, auth]);

  // Helper: attach user's feed info to article rows (for NEW in list)
  const attachFeedToRows = useCallback(async (rows) => {
    const uid = auth.currentUser?.uid;
    if (!uid || !rows?.length) return rows;
    const withFeed = await Promise.all(rows.map(async (a) => {
      try {
        const fref = doc(db, 'users', uid, 'articleFeeds', a.id);
        const fsnap = await getDoc(fref);
        return fsnap.exists() ? { ...a, feed: { id: fsnap.id, ...fsnap.data() } } : a;
      } catch (_) { return a; }
    }));
    return withFeed;
  }, [auth, db]);

  const fetchFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      await fetchRecommended();
      const q = query(collection(db, 'articles'), orderBy('createdAt', 'desc'), limit(PAGE_SIZE));
      const snap = await getDocs(q);
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const rowsWithFeed = await attachFeedToRows(rows);
      setArticles(rowsWithFeed);
      lastDocRef.current = snap.docs[snap.docs.length - 1] || null;
    } finally {
      setLoading(false);
    }
  }, [db, fetchRecommended, attachFeedToRows]);

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
      const rowsWithFeed = await attachFeedToRows(rows);
      setArticles(prev => [...prev, ...rowsWithFeed]);
      lastDocRef.current = snap.docs[snap.docs.length - 1] || null;
    } finally {
      setLoadingMore(false);
    }
  }, [db, loadingMore, attachFeedToRows]);

  // Live subscribe to user's recent feeds for "今日のおすすめ"
  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return; // unauthenticated: rely on fallback fetchRecommended
    const feedsQ = query(collection(db, 'users', uid, 'articleFeeds'), orderBy('deliveredAt', 'desc'), limit(5));
    const unsub = onSnapshot(feedsQ, async (snap) => {
      try {
        if (snap.empty) {
          // keep fallback (latest)
          await fetchRecommended();
          return;
        }
        const items = [];
        for (const fd of snap.docs) {
          const feed = { id: fd.id, ...fd.data() };
          const artRef = doc(db, 'articles', fd.id);
          const artSnap = await getDoc(artRef);
          if (artSnap.exists()) items.push({ id: artSnap.id, ...artSnap.data(), feed });
        }
        setRecommended(items);
        // Also patch feed status into the list to keep NEW in sync
        const feedMap = Object.fromEntries(items.map(it => [it.id, it.feed]));
        setArticles(prev => prev.map(a => (feedMap[a.id] ? { ...a, feed: feedMap[a.id] } : a)));
      } catch (e) {
        console.warn('[ArticleHub] feed snapshot join failed', e?.message || e);
      }
    });
    return () => unsub();
  }, [auth, db, fetchRecommended]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchFirstPage();
    setRefreshing(false);
  }, [fetchFirstPage]);

  useEffect(() => {
    fetchFirstPage();
  }, [fetchFirstPage]);

  // Refresh recommended when returning from detail so NEW reflects readAt
  useFocusEffect(
    useCallback(() => {
      fetchRecommended();
    }, [fetchRecommended])
  );

  const handleDeliverFeeds = useCallback(async () => {
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) {
        Alert.alert('未サインイン', 'フィード配信にはサインインが必要です。');
        return;
      }
      const resp = await fetch(`${CF_BASE}/deliverDailyFeeds?uid=${encodeURIComponent(uid)}`);
      const json = await resp.json();
      if (!json.ok) throw new Error(json.error || '配信に失敗しました');
      await fetchRecommended();
      Alert.alert('配信完了', `新着 ${json.totalDelivered || 0} 件`);
    } catch (e) {
      Alert.alert('配信エラー', String(e?.message || e));
    }
  }, [auth, CF_BASE, fetchRecommended]);

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (__DEV__ ? (
        <View style={{ flexDirection: 'row' }}>
          <TouchableOpacity onPress={handleDeliverFeeds} style={{ marginRight: 12 }}>
            <Text style={{ color: '#007AFF', fontWeight: '700' }}>配信</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleGenerateSeeds}
            style={{ marginRight: 12, opacity: seeding ? 0.6 : 1 }}
            disabled={seeding}
          >
            <Text style={{ color: '#007AFF', fontWeight: '700' }}>
              {seeding ? '生成中…' : '記事生成'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null),
    });
  }, [navigation, handleGenerateSeeds, seeding, handleDeliverFeeds]);

  const handleSubmitCompose = useCallback(async () => {
    try {
      const topic = composeTopic.trim();
      if (!topic) {
        Alert.alert('入力不足', 'トピック（作成したい記事のテーマ）を入力してください。');
        return;
      }

      const payload = {
        topic,
        uid: auth.currentUser?.uid || undefined, // for HTTP fallback to create feed
      };

      // まず callable を試し、401等で落ちたら HTTP 公開版にフォールバック
      let ok = false;
      let articleId = null;
      setCreating(true);
      try {
        const requestArticleCreation = httpsCallable(functions, 'requestArticleCreation');
        const res = await requestArticleCreation(payload);
        articleId = res?.data?.articleId || res?.data?.createdId || null;
        ok = true;
      } catch (err) {
        console.warn('[ArticleHub] callable requestArticleCreation failed, fallback to HTTP:', err?.message || err);
        try {
          const resp = await fetch(`${CF_BASE}/requestArticleCreationHttp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const json = await resp.json();
          if (!json.ok) throw new Error(json.error || 'requestArticleCreationHttp failed');
          articleId = json.articleId || null;
          ok = true;
        } catch (err2) {
          throw err2;
        }
      }

      setShowComposer(false);
      setComposeTopic('');
      // Ensure feed contains the new article for current user
      try {
        const uid = auth.currentUser?.uid;
        if (uid) await fetch(`${CF_BASE}/deliverDailyFeeds?uid=${encodeURIComponent(uid)}&limit=5`);
      } catch (_) {}
      await fetchRecommended();
      await fetchFirstPage();
      Alert.alert('受付しました', `記事の作成を開始しました。${articleId ? `ID: ${articleId}` : ''}`.trim());
    } catch (e) {
      console.warn('[ArticleHub] requestArticleCreation failed:', e);
      const msg = (e && e.message) || (e && e.code) || '関数の呼び出しに失敗しました';
      Alert.alert('作成エラー', String(msg));
    } finally { setCreating(false); }
  }, [composeTopic, functions, fetchFirstPage, fetchRecommended, auth, CF_BASE]);

  const renderCard = useCallback((item, isHero = false) => {
    const img = item?.image?.url;
    const isBusy = generating.has(item.id);
    const isNew = !!(item?.feed && !item.feed.readAt);
    const preview = String((Array.isArray(item?.sections) && item.sections[0]) || item?.body || '')
      .replace(/\s+/g, ' ')
      .trim();

    const GenerateBadge = () => (
      <Pressable
        onPress={withGenerating(item.id, () => ensureImage(item.id))}
        style={styles.genBadge}
        accessibilityLabel="この記事の画像を生成"
      >
        <Text style={styles.genBadgeText}>画像生成</Text>
      </Pressable>
    );

    const BusyOverlay = () => (
      <View style={styles.busyOverlay} pointerEvents="none">
        <ActivityIndicator />
      </View>
    );

    if (isHero) {
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
            <View style={styles.cardImagePlaceholder}>
              <Text style={styles.phIcon}>📖</Text>
              <Text style={styles.phHelp}>画像が未設定です</Text>
              <GenerateBadge />
            </View>
          )}
          {isBusy && <BusyOverlay />}
          {isNew && (
            <View style={styles.newBadgeWrap}>
              <Text style={styles.newBadgeText}>NEW</Text>
            </View>
          )}
          <View style={styles.cardContent}>
            <Text numberOfLines={2} style={styles.cardTitle}>{item.title || '無題の記事'}</Text>
            <Text numberOfLines={1} style={styles.cardSub}>
              {item.monthAge != null ? `生後${item.monthAge}か月` : '記事'}
              {item.tags?.length ? ` ・ ${item.tags[0]}` : ''}
            </Text>
            {!!preview && (
              <Text numberOfLines={2} style={styles.cardPreview}>{preview}</Text>
            )}
          </View>
        </TouchableOpacity>
      );
    }

    return (
      <TouchableOpacity
        key={item.id}
        style={styles.compactRow}
        activeOpacity={0.8}
        onPress={() => navigation.navigate('MonthlyArticle', { articleId: item.id })}
      >
        <View style={{ position: 'relative' }}>
          {img ? (
            <Image source={{ uri: img }} style={styles.thumb} resizeMode="cover" />
          ) : (
            <View style={styles.thumbPlaceholder}>
              <Text style={styles.phIconMini}>📖</Text>
              <GenerateBadge />
            </View>
          )}
          {isBusy && <View style={styles.busyThumb}><ActivityIndicator /></View>}
        </View>
        <View style={styles.compactContent}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text numberOfLines={2} style={[styles.compactTitle, { flex: 0 }]}>{item.title || '無題の記事'}</Text>
            {isNew && (
              <View style={styles.newPill}>
                <Text style={styles.newPillText}>NEW</Text>
              </View>
            )}
          </View>
          <View style={styles.metaRow}>
            {item.monthAge != null && (
              <View style={styles.pill}><Text style={styles.pillText}>生後{item.monthAge}か月</Text></View>
            )}
            {!!(item.tags && item.tags.length) && (
              <View style={styles.pill}><Text style={styles.pillText}>{item.tags[0]}</Text></View>
            )}
          </View>
          {!!preview && (
            <Text numberOfLines={2} style={styles.compactPreview}>{preview}</Text>
          )}
        </View>
      </TouchableOpacity>
    );
  }, [navigation, ensureImage, generating]);

  const HeroHeader = useMemo(() => (
    <Animated.View style={[styles.headerWrap, { opacity: heroOpacity }]}>
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
        {(seeding || creating) && (
          <View style={{ marginTop: 8 }}>
            <Text style={{ fontSize: 12, color: '#6B7280' }}>
              {creating ? '作成を受け付けました。数秒〜十数秒で一覧に反映されます…' : '記事生成中…（数秒お待ちください）'}
            </Text>
          </View>
        )}
      </View>
    </Animated.View>
  ), [search, recentCount, totalCount, lastUpdatedText, seeding, creating, heroOpacity]);

  // Sticky rail + list title + articles
  const listData = useMemo(() => [{ __type: 'rail' }, { __type: 'listTitle' }, ...(filteredArticles || [])], [filteredArticles]);

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
              style={[styles.modalInput, styles.modalTextarea]}
              placeholder="キーワード/要望（例：6〜8か月の離乳食ステップ。食材の進め方、安全面、頻度の目安）"
              placeholderTextColor="#9BA0A6"
              value={composeTopic}
              onChangeText={setComposeTopic}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
              returnKeyType="done"
              blurOnSubmit
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalCancel]} onPress={() => setShowComposer(false)}>
                <Text style={styles.modalBtnTextCancel}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalSubmit, creating && { opacity: 0.6 }]} onPress={creating ? undefined : handleSubmitCompose} disabled={creating}>
                {creating ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalBtnTextSubmit}>作成を依頼</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Animated.FlatList
        data={listData}
        keyExtractor={(item, index) => item?.__type ? `${item.__type}-${index}` : `${item.id}`}
        ListHeaderComponent={HeroHeader}
        style={styles.listBg}
        renderItem={({ item }) => {
          if (item?.__type === 'rail') {
            return (
              <View style={styles.railStickyWrap}>
                <Text style={[styles.sectionTitle, { marginHorizontal: 16 }]}>🆕 今日のおすすめ</Text>
                <View style={[styles.recoWrap, { paddingTop: 4 }]}> 
                  {recommended.length > 0 ? (
                    <FlatList
                      data={recommended}
                      keyExtractor={(it) => it.id}
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={{ paddingRight: 8 }}
                      ItemSeparatorComponent={() => <View style={{ width: 12 }} />}
                      renderItem={({ item: it }) => (
                        <View style={{ width: 300 }}>{renderCard(it, true)}</View>
                      )}
                    />
                  ) : (
                    <Text style={[styles.emptyText, { marginHorizontal: 16 }]}>おすすめ記事がまだありません</Text>
                  )}
                </View>
              </View>
            );
          }
          if (item?.__type === 'listTitle') {
            return <Text style={[styles.sectionTitle, { marginTop: 8, marginHorizontal: 16 }]}>📚 記事一覧</Text>;
          }
          return renderCard(item);
        }}
        contentContainerStyle={styles.listContent}
        stickyHeaderIndices={[1]}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: false })}
        scrollEventThrottle={16}
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
  emptyText: { fontSize: 14, color: '#A0A0A0', textAlign: 'left' },
  pageTitle: { fontSize: 26, fontWeight: '900', color: '#111827' },
  recoWrap: { gap: 12, marginBottom: 8, paddingVertical: 4 },
  listBg: { backgroundColor: '#FAFAFA' },
  railStickyWrap: {
    backgroundColor: '#FAFAFA',
    paddingBottom: 6,
    // 下にスクロールする一覧が透けて見えないよう、背景のみを維持（線/影なし）
    zIndex: 2,
  },
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
  newBadgeWrap: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: '#FF3B30',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  newBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  newPill: {
    marginLeft: 8,
    backgroundColor: '#FF3B30',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  newPillText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  genBadge: {
    marginTop: 6,
    alignSelf: 'center',
    backgroundColor: '#6C63FF',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  genBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  phHelp: { marginTop: 6, fontSize: 12, color: '#666' },
  busyOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.4)'
  },
  busyThumb: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderRadius: 8,
  },
  cardContent: { padding: 12 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: '#222', marginBottom: 4 },
  cardSub: { fontSize: 13, color: '#666' },
  cardPreview: { marginTop: 6, fontSize: 13, color: '#444' },

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
  compactPreview: { marginTop: 4, fontSize: 12, color: '#555' },
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
