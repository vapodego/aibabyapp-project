import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

const DayPlanScreen = ({ route, navigation }) => {
  const { detailedPlan } = route.params;

  if (!detailedPlan) {
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
  
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={28} color="#333" />
        </TouchableOpacity>
        <Text style={styles.title}>1日の詳細プラン</Text>
        <View style={{width: 36}} />
      </View>
      <ScrollView contentContainerStyle={styles.resultContainer}>
        <Text style={styles.resultTitle}>{detailedPlan.eventInfo.eventName}</Text>
        {detailedPlan.eventInfo.date && <Text style={styles.resultDate}>{detailedPlan.eventInfo.date}</Text>}
        
        <View style={styles.section}>
            <Text style={styles.sectionTitle}>📝 1日のスケジュール</Text>
            {detailedPlan.schedule.map((item, index) => (
                <View key={index} style={styles.scheduleItem}>
                    <Text style={styles.scheduleTime}>{item.time}</Text>
                    <Text style={styles.scheduleAction}>{item.action}</Text>
                </View>
            ))}
            {detailedPlan.schedule_details && <Text style={styles.adviceText}>{detailedPlan.schedule_details}</Text>}
        </View>

        <View style={styles.section}>
            <Text style={styles.sectionTitle}>🎒 持ち物リスト</Text>
            {detailedPlan.items_to_bring.map((item, index) => (
                 <Text key={index} style={styles.listItem}>・ {item}</Text>
            ))}
        </View>

        <View style={styles.section}>
            <Text style={styles.sectionTitle}>💡 事前準備とアドバイス</Text>
            <Text style={styles.adviceText}>{detailedPlan.preparation_tips}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F7F7F7' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 16, backgroundColor: 'white', borderBottomWidth: 1, borderBottomColor: '#EEE' },
    backButton: { padding: 4 },
    title: { fontSize: 20, fontWeight: 'bold', color: '#333' },
    resultContainer: { padding: 20 },
    resultTitle: { fontSize: 24, fontWeight: 'bold', color: '#333', marginBottom: 4 },
    resultDate: { fontSize: 16, color: '#666', marginBottom: 24 },
    section: { marginBottom: 24 },
    sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#444', marginBottom: 12, borderBottomWidth: 2, borderBottomColor: '#FF6347', paddingBottom: 4 },
    scheduleItem: { flexDirection: 'row', marginBottom: 10, alignItems: 'center' },
    scheduleTime: { width: 80, fontSize: 15, fontWeight: 'bold', color: '#333' },
    scheduleAction: { flex: 1, fontSize: 15, color: '#555' },
    listItem: { fontSize: 15, color: '#555', lineHeight: 22 },
    adviceText: { fontSize: 15, color: '#555', lineHeight: 22, marginTop: 8 },
});

export default DayPlanScreen;