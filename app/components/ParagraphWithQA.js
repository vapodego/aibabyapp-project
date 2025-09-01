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
                          <View key={i} style={{ marginBottom: 6 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
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
                                  const asKey = key; // 正規化キー
                                  try {
                                    const childCount = Array.isArray(childAnswersBySentence?.[asKey]) ? childAnswersBySentence[asKey].length : 0;
                                    const expanded = !!expandedNestedSentences?.[asKey];
                                    onDebug?.({ tag: 'tap-answer', as: display, asKey, childCount, expanded, debugChildKeysCount: (debugChildKeys || []).length, debugExpandedKeysCount: (debugExpandedKeys || []).length });
                                  } catch {}
                                  onPressAnswerSentence?.(sent, baseDepth);
                                }}
                                style={{ flex: 1 }}
                              >
                                <InlineMD
                                  text={display}
                                  style={[styles.answerSentence, { paddingVertical: 4 }, key === normalizeKey(selectedSentence) && (styles.selectedAnswer || styles.selectedSentence)]}
                                />
                              </TouchableOpacity>
                            </View>

                            {/* L2 折りたたみ表示（ひらく）: 子回答があるが閉じている場合にヒント行を表示 */}
                            {(() => {
                              try {
                                const cnt = Array.isArray(childAnswersBySentence?.[key]) ? childAnswersBySentence[key].length : 0;
                                const open = !!expandedNestedSentences?.[key];
                                if (cnt > 0 && !open) {
                                  return (
                                    <View style={[styles.nestedHeader, { paddingHorizontal: 8, paddingVertical: 4, marginLeft: hadBullet ? 22 : 16 }] }>
                                      <Text style={styles.nestedIcon}>💬</Text>
                                      <Text numberOfLines={1} style={styles.nestedSummary}>追回答 {cnt}件</Text>
                                      <TouchableOpacity onPress={() => onToggleNestedExpand?.(key)}>
                                        <Text style={styles.nestedToggle}>ひらく</Text>
                                      </TouchableOpacity>
                                    </View>
                                  );
                                }
                              } catch(_) {}
                              return null;
                            })()}

                            {/* L2（child）: 最新回答行の直下に子回答を表示（縦積み） */}
                            {expandedNestedSentences?.[key] ? (
                              <View style={[styles.nestedBlock, { marginLeft: (hadBullet ? 22 : 16) }]}> 
                                {/* L2 ヘッダー（質問 + とじる/ひらく） */}
                                {(() => {
                                  const list = childAnswersBySentence?.[key] || [];
                                  const first = list[0] || null;
                                  const qtext = first && first.question ? String(first.question) : '';
                                  return (
                                    <View style={styles.nestedHeader}>
                                      <Text style={styles.nestedIcon}>💬</Text>
                                      <Text numberOfLines={1} style={styles.nestedSummary}>
                                        {qtext ? `Q: ${qtext}` : '追回答'}
                                      </Text>
                                      <TouchableOpacity onPress={() => onToggleNestedExpand?.(key)}>
                                        <Text style={styles.nestedToggle}>とじる</Text>
                                      </TouchableOpacity>
                                    </View>
                                  );
                                })()}
                                <View style={styles.nestedBody}>
                                  {(childAnswersBySentence?.[key] || []).map((cqa, m) => (
                                    <View key={m} style={{ marginBottom: 4 }}>
                                      {String(cqa.answer).split(/\r?\n/)
                                        .map((raw) => String(raw).trim())
                                        .filter(Boolean)
                                      .map((line2, n) => {
                                        const { display: as2, key: as2Key } = parseAnswerLine(line2);
                                        const hadBullet2 = as2 !== line2;
                                        return (
                                          <View key={n} style={{ flexDirection: 'column' }}>
                                            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                                              {hadBullet2 ? <Text style={[styles.answerSentence, { paddingVertical: 4, marginRight: 6 }]}>•</Text> : null}
                                              <TouchableOpacity
                                                activeOpacity={0.7}
                                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                                accessibilityRole="button"
                                                accessibilityLabel={`回答文をタップして深掘り。現在の深さは${(cqa && typeof cqa.depth === 'number') ? cqa.depth : 2}です`}
                                                onPress={() => {
                                                  const baseDepth = (cqa && typeof cqa.depth === 'number') ? cqa.depth : 2;
                                                  onPressAnswerSentence?.(as2, baseDepth);
                                                  try {
                                                    const isExpandedNow = !!expandedGrandNested?.[as2Key];
                                                    if (!isExpandedNow) onToggleGrandNestedExpand?.(as2Key);
                                                  } catch {}
                                                }}
                                                style={{ flex: 1 }}
                                              >
                                                <InlineMD text={as2} style={[styles.answerSentence, { paddingVertical: 4 }, as2Key === normalizeKey(selectedSentence) && styles.selectedSentence]} />
                                              </TouchableOpacity>
                                            </View>

                                            {/* L3（grand）: 孫回答 */}
                                            {expandedGrandNested?.[as2Key] ? (
                                              <View style={{ marginLeft: hadBullet2 ? 22 : 16, marginTop: 4 }}>
                                                {(grandAnswersBySentence?.[as2Key] || []).map((gqa, t) => (
                                                  <View key={t} style={{ marginBottom: 4 }}>
                                                    {String(gqa.answer).split(/\r?\n/)
                                                      .map((raw) => String(raw).trim())
                                                      .filter(Boolean)
                                                      .map((line3, u) => {
                                                        const { display: as3, key: as3Key } = parseAnswerLine(line3);
                                                        const hadBullet3 = as3 !== line3;
                                                        return (
                                                          <View key={u} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                                                            {hadBullet3 ? <Text style={[styles.answerSentence, { paddingVertical: 4, marginRight: 6 }]}>•</Text> : null}
                                                            <TouchableOpacity
                                                              activeOpacity={0.7}
                                                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                                              accessibilityRole="button"
                                                              accessibilityLabel={`回答文をタップして深掘り。現在の深さは${(gqa && typeof gqa.depth === 'number') ? gqa.depth : 3}です`}
                                                              onPress={() => onPressAnswerSentence?.(as3, gqa?.depth)}
                                                              style={{ flex: 1 }}
                                                            >
                                                              <InlineMD text={as3} style={[styles.answerSentence, { paddingVertical: 4 }, as3Key === normalizeKey(selectedSentence) && styles.selectedSentence]} />
                                                            </TouchableOpacity>
                                                          </View>
                                                        );
                                                      })}
                                                  </View>
                                                ))}
                                              </View>
                                            ) : (
                                              // L3 折りたたみ表示（ひらく）: 孫回答があるが閉じている場合
                                              (() => {
                                                try {
                                                  const gcnt = Array.isArray(grandAnswersBySentence?.[as2Key]) ? grandAnswersBySentence[as2Key].length : 0;
                                                  if (gcnt > 0) {
                                                    return (
                                                      <View style={[styles.nestedHeader, { paddingHorizontal: 8, paddingVertical: 4, marginLeft: hadBullet2 ? 22 : 16 }] }>
                                                        <Text style={styles.nestedIcon}>↳</Text>
                                                        <Text numberOfLines={1} style={styles.nestedSummary}>さらに {gcnt} 件</Text>
                                                        <TouchableOpacity onPress={() => onToggleGrandNestedExpand?.(as2Key)}>
                                                          <Text style={styles.nestedToggle}>ひらく</Text>
                                                        </TouchableOpacity>
                                                      </View>
                                                    );
                                                  }
                                                } catch(_) {}
                                                return null;
                                              })()
                                            )}
                                          </View>
                                        );
                                      })}
                                  </View>
                                ))}
                                </View>
                              </View>
                            ) : null}
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
