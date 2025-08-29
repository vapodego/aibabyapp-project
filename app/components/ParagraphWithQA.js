// app/components/ParagraphWithQA.js
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import NestedQA, { splitToSentences, InlineMD } from './NestedQA';
import { normalizeKey, parseAnswerLine } from '../utils/keying';

// Extract plain text from answer which may be either a string or an object { text }
const getAnswerText = (ans) => (typeof ans === 'string' ? ans : (ans && typeof ans.text === 'string' ? ans.text : ''));

/**
 * 1パラグラフ（複数文）＋ピン留めQAの表示専用コンポーネント
 */
export default function ParagraphWithQA({
  text,
  onPressSentence,
  selectedSentence,
  answersBySentence = {},
  expandedSentences = {},
  onToggleExpand = () => {},
  onPressAnswerSentence = () => {},
  onLayoutSentence = null,
  childAnswersBySentence = {},
  expandedNestedSentences = {},
  onToggleNestedExpand = () => {},
  grandAnswersBySentence = {},
  expandedGrandNested = {},
  onToggleGrandNestedExpand = () => {},
  styles,
  onDebug,
  debugChildKeys = [],
  debugExpandedKeys = [],
}) {
  const pieces = useMemo(() => splitToSentences(text), [text]);

  return (
    <View>
      {pieces.map((s, idx) => {
        const qaList = answersBySentence[s] || [];
        const isExpanded = !!expandedSentences[s];
        const latest = qaList[0];

        return (
          <View key={idx} onLayout={(e) => onLayoutSentence && onLayoutSentence(s, e.nativeEvent.layout.y)}>
            <TouchableOpacity activeOpacity={0.8} onPress={() => onPressSentence(s)}>
              <Text style={[styles.paragraphSentence, s === selectedSentence && styles.selectedSentence]}>
                {s}
              </Text>
            </TouchableOpacity>

            {qaList.length > 0 && (
              <View style={styles.pinBlock}>
                <TouchableOpacity
                  style={styles.pinHeader}
                  onPress={() => onToggleExpand(s)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={isExpanded ? 'ピン留め回答をとじる' : 'ピン留め回答をひらく'}
                >
                  <Text style={styles.pinIcon}>📌</Text>
                  <Text numberOfLines={1} style={styles.pinSummary}>
                    {latest?.question ? `Q: ${latest.question}` : '回答あり'}
                  </Text>
                  {/* 件数バッジ */}
                  <Text style={styles.pinCount || { marginLeft: 8, fontSize: 12, color: '#6B7280' }}>
                    💬 {qaList.length}
                  </Text>
                  <Text style={styles.pinToggle}>{isExpanded ? 'とじる' : 'ひらく'}</Text>
                </TouchableOpacity>

                {isExpanded && latest?.answer ? (
                  <View style={{ marginTop: 8 }}>
                    {/* 文ごとのタップ（深掘り用） */}
                    {getAnswerText(latest?.answer).split(/\r?\n/)
                      .map((raw) => String(raw).trim())
                      .filter(Boolean)
                      .map((line, i) => {
                        const { display, key } = parseAnswerLine(line); // 共通ロジック
                        const sent = display; // 保存・選択用も display に統一
                        const hadBullet = display !== line; // 行頭の記号が除去されたかで判定（簡易）
                        return (
                          <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                            {hadBullet ? (
                              <Text style={[styles.answerSentence, { paddingVertical: 4, marginRight: 6 }]}>•</Text>
                            ) : null}
                            <TouchableOpacity
                              activeOpacity={0.7}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              accessibilityRole="button"
                              accessibilityLabel={`回答文をタップして深掘り。現在の深さは${(latest && typeof latest.depth === 'number') ? latest.depth : 1}です`}
                              onPress={() => {
                                const baseDepth = (latest && typeof latest.depth === 'number') ? latest.depth : 1;
                                const asKey = key; // 正規化キーは常にこれを使用

                                // Debug: report keys/counts at tap time
                                try {
                                  const childCount = Array.isArray(childAnswersBySentence?.[asKey]) ? childAnswersBySentence[asKey].length : 0;
                                  const expanded = !!expandedNestedSentences?.[asKey];
                                  onDebug?.({
                                    tag: 'tap-answer',
                                    as: display,
                                    asKey,
                                    childCount,
                                    expanded,
                                    debugChildKeysCount: (debugChildKeys || []).length,
                                    debugExpandedKeysCount: (debugExpandedKeys || []).length,
                                  });
                                } catch {}

                                // まず質問を投げる（display は表示用、キーはサーバで normKey に変換）
                                onPressAnswerSentence?.(sent, baseDepth);

                                // 未展開のときだけ自動で開く（毎回トグルしない）
                                try {
                                  const isExpandedNow = !!expandedNestedSentences?.[asKey];
                                  if (!isExpandedNow) {
                                    onToggleNestedExpand?.(asKey);
                                  }
                                } catch {}
                              }}
                              style={{ flex: 1 }}
                            >
                              <InlineMD
                                text={display}
                                style={[
                                  styles.answerSentence,
                                  { paddingVertical: 4 },
                                  key === normalizeKey(selectedSentence) && styles.selectedSentence,
                                ]}
                              />
                            </TouchableOpacity>
                          </View>
                        );
                      })}

                    {/* 過去/新規の追回答の表示（Markdown 含む） */}
                    <NestedQA
                      qaList={qaList}
                      selectedSentence={selectedSentence}
                      onPressAnswerSentence={onPressAnswerSentence}
                      childAnswersBySentence={childAnswersBySentence}
                      expandedNestedSentences={expandedNestedSentences}
                      toggleNestedExpand={onToggleNestedExpand}
                      grandAnswersBySentence={grandAnswersBySentence}
                      expandedGrandNested={expandedGrandNested}
                      toggleGrandNestedExpand={onToggleGrandNestedExpand}
                      styles={styles}
                      hideBase={true}
                      onDebug={onDebug}
                    />
                  </View>
                ) : null}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}