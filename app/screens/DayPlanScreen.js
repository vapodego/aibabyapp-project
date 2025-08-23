import React, { useMemo, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Linking, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import MapView, { Marker, Polyline } from 'react-native-maps';
import polyline from '@mapbox/polyline';

// AIが生成したスケジュールテキスト（マークダウン形式）を解析して、扱いやすい配列に変換するヘルパー関数
const parseSchedule = (scheduleText) => {
  if (!scheduleText || typeof scheduleText !== 'string') return [];
  try {
    const lines = scheduleText.split('\n').filter(line => line.startsWith('|') && !line.includes('---') && line.length > 3);
    return lines.map(line => {
      const parts = line.split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        return { time: parts[0], action: parts[1], details: parts[2] || '' }; // 詳細列も取得
      }
      return null;
    }).filter(Boolean);
  } catch (e) {
    console.error("スケジュールの解析に失敗:", e);
    return [];
  }
};

// ヘルパーコンポーネント
const InfoCard = ({ icon, title, children, color = '#FF6347' }) => (
    <View style={styles.section}>
        <View style={styles.sectionHeader}>
            <Ionicons name={icon} size={22} color={color} style={{ marginRight: 8 }} />
            <Text style={styles.sectionTitle}>{title}</Text>
        </View>
        <Text style={styles.adviceText}>{children}</Text>
    </View>
);

const DayPlanScreen = ({ route, navigation }) => {
  const { detailedPlan } = route.params || {};
  const mapRef = useRef(null);

  // バックエンドから渡されたポリライン文字列を、地図で使える座標の配列にデコード
  const decodedCoordinates = useMemo(() => {
    if (!detailedPlan?.map_polyline) return [];
    // polyline.decodeは[lat, lng]の配列を返すので、{latitude, longitude}の形式に変換
    return polyline.decode(detailedPlan.map_polyline).map(point => ({
        latitude: point[0],
        longitude: point[1],
    }));
  }, [detailedPlan?.map_polyline]);

  // 地図の表示範囲を、取得した経路全体に自動で合わせる
  useEffect(() => {
    if (decodedCoordinates.length > 1 && mapRef.current) {
        mapRef.current.fitToCoordinates(decodedCoordinates, {
            edgePadding: { top: 50, right: 50, bottom: 50, left: 50 },
            animated: true,
        });
    }
  }, [decodedCoordinates]);

  // Googleマップアプリでナビを開始する関数
  const startNavigation = () => {
    const { eventAddress, endLocation } = detailedPlan;
    // 緯度経度よりも、住所で指定する方が確実でユーザーにも分かりやすい
    const destination = encodeURIComponent(eventAddress || `${endLocation.lat},${endLocation.lng}`);
    const url = `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
    
    Linking.openURL(url).catch(err => {
        console.error('マップアプリの起動に失敗', err);
        Alert.alert('エラー', 'Googleマップの起動に失敗しました。');
    });
  };

  if (!detailedPlan) {
    // ... エラー表示部分は変更なし ...
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <Ionicons name="chevron-back" size={28} color="#333" />
          </TouchableOpacity>
          <Text style={styles.title}>エラー</Text>
          <View style={{width: 36}} />
        </View>
        <View style={styles.centered}>
          <Text>プランデータの表示に失敗しました。</Text>
        </View>
      </SafeAreaView>
    );
  }

  const scheduleItems = parseSchedule(detailedPlan.schedule);
  const { startLocation, endLocation } = detailedPlan;
  
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={28} color="#333" />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{detailedPlan.planName}</Text>
        <TouchableOpacity onPress={() => {}} style={styles.actionButton}>
            <Ionicons name="share-social-outline" size={24} color="#333" />
        </TouchableOpacity>
      </View>
      
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.eventHeader}>
            <Text style={styles.resultTitle}>{detailedPlan.eventName}</Text>
            {detailedPlan.date && <Text style={styles.resultDate}>{detailedPlan.date}</Text>}
            {(detailedPlan?.eventUrl || detailedPlan?.url) ? (
              <TouchableOpacity
                onPress={() => Linking.openURL(detailedPlan.eventUrl || detailedPlan.url)}
                style={styles.eventLinkButton}
                accessibilityRole="button"
              >
                <Ionicons name="link-outline" size={18} color="#fff" style={{ marginRight: 6 }} />
                <Text style={styles.eventLinkText}>イベントページを開く</Text>
              </TouchableOpacity>
            ) : null}
        </View>

        {/* --- ▼▼▼ 地図コンポーネント ▼▼▼ --- */}
        {decodedCoordinates.length > 0 && (
            <View style={styles.mapContainer}>
                <MapView
                    ref={mapRef}
                    style={styles.map}
                    initialRegion={{ // 初期表示位置（目的地中心）
                        latitude: endLocation.lat,
                        longitude: endLocation.lng,
                        latitudeDelta: 0.0922,
                        longitudeDelta: 0.0421,
                    }}
                >
                    <Polyline
                        coordinates={decodedCoordinates}
                        strokeColor="#FF6347"
                        strokeWidth={5}
                    />
                    {startLocation && <Marker coordinate={{ latitude: startLocation.lat, longitude: startLocation.lng }} title="出発地" pinColor="blue" />}
                    {endLocation && <Marker coordinate={{ latitude: endLocation.lat, longitude: endLocation.lng }} title={detailedPlan.eventName} />}
                </MapView>
                <TouchableOpacity style={styles.navigateButton} onPress={startNavigation}>
                    <Ionicons name="navigate-circle-outline" size={24} color="white" />
                    <Text style={styles.navigateButtonText}>Googleマップでナビを開始</Text>
                </TouchableOpacity>
            </View>
        )}
        
        {/* --- ▼▼▼ 戦略ガイド ▼▼▼ --- */}
        {detailedPlan.strategicGuide &&
          <InfoCard icon="map-outline" title="戦略ガイド＆アクセス">
              {detailedPlan.strategicGuide.logistics}
          </InfoCard>
        }

        {/* --- ▼▼▼ スケジュール ▼▼▼ --- */}
        <View style={styles.section}>
            <View style={styles.sectionHeader}>
                <Ionicons name="list-outline" size={22} color="#4A90E2" style={{ marginRight: 8 }}/>
                <Text style={styles.sectionTitle}>1日のスケジュール</Text>
            </View>
            {scheduleItems.length > 0 ? (
              scheduleItems.map((item, index) => (
                  <View key={index} style={styles.scheduleItem}>
                      <View style={styles.timeline}>
                          <View style={styles.timelineDot} />
                          <View style={styles.timelineLine} />
                      </View>
                      <View style={styles.scheduleContent}>
                          <Text style={styles.scheduleTime}>{item.time}</Text>
                          <Text style={styles.scheduleAction}>{item.action}</Text>
                          <Text style={styles.scheduleDetails}>{item.details}</Text>
                      </View>
                  </View>
              ))
            ) : (
              <Text style={styles.adviceText}>詳細なスケジュール情報はありません。</Text>
            )}
        </View>

        {/* --- ▼▼▼ 持ち物とアドバイス ▼▼▼ --- */}
        {detailedPlan.items_to_bring && (
          <InfoCard icon="briefcase-outline" title="持ち物リスト" color="#F5A623">
              {detailedPlan.items_to_bring.join(', ')}
          </InfoCard>
        )}

        {detailedPlan.preparation_tips && (
          <InfoCard icon="bulb-outline" title="事前準備とアドバイス" color="#7ED321">
              {detailedPlan.preparation_tips}
          </InfoCard>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F8F9FA' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 16, backgroundColor: 'white', borderBottomWidth: 1, borderBottomColor: '#E9ECEF' },
    backButton: { padding: 4, width: 36, alignItems: 'flex-start' },
    title: { fontSize: 18, fontWeight: 'bold', color: '#212529', flex: 1, textAlign: 'center' },
    actionButton: { padding: 4, width: 36, alignItems: 'flex-end' },
    scrollContent: { paddingBottom: 40 },
    eventHeader: { paddingHorizontal: 20, paddingVertical: 16, alignItems: 'center' },
    resultTitle: { fontSize: 26, fontWeight: 'bold', color: '#212529', marginBottom: 4, textAlign: 'center' },
    resultDate: { fontSize: 16, color: '#6C757D', marginBottom: 16 },

    mapContainer: { marginHorizontal: 16, borderRadius: 16, overflow: 'hidden', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2, }, shadowOpacity: 0.1, shadowRadius: 4, marginBottom: 20, },
    map: { width: '100%', height: 250, },
    navigateButton: { position: 'absolute', bottom: 12, left: '50%', transform: [{ translateX: -125 }], width: 250, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#007AFF', paddingVertical: 12, borderRadius: 30, elevation: 5 },
    navigateButtonText: { color: 'white', fontSize: 16, fontWeight: 'bold', marginLeft: 8 },

    section: { backgroundColor: 'white', marginHorizontal: 16, borderRadius: 12, padding: 16, marginBottom: 16 },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, borderBottomWidth: 1, borderBottomColor: '#F1F3F5', paddingBottom: 8 },
    sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#343A40' },

    scheduleItem: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
    timeline: { alignItems: 'center', marginRight: 12, },
    timelineDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#4A90E2', zIndex: 1 },
    timelineLine: { flex: 1, width: 2, backgroundColor: '#E9ECEF', marginTop: -4 },
    scheduleContent: { flex: 1 },
    scheduleTime: { fontSize: 14, fontWeight: 'bold', color: '#343A40', marginBottom: 2 },
    scheduleAction: { fontSize: 16, color: '#495057', fontWeight: '600' },
    scheduleDetails: { fontSize: 14, color: '#868E96', marginTop: 4 },

    adviceText: { fontSize: 15, color: '#495057', lineHeight: 24, },

    eventLinkButton: {
      marginTop: 8,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#2563EB',
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 8,
    },
    eventLinkText: {
      color: '#fff',
      fontSize: 14,
      fontWeight: '700',
    },
});

export default DayPlanScreen;