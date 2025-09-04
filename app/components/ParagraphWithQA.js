// app/components/ParagraphWithQA.js
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import Markdown from 'react-native-markdown-display';
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
  navigation = null,
}) {
  const pieces = useMemo(() => splitToSentences(text), [text]);
  // Precompute child and grand totals per key for performance
  const { childLenMap, grandTotalMap } = useMemo(() => {
    const cMap = new Map();
    const gMap = new Map();
    try {
      const obj = childAnswersBySentence || {};
      Object.keys(obj).forEach((k2) => {
        const arr = Array.isArray(obj[k2]) ? obj[k2] : [];
        cMap.set(k2, arr.length);
        const k3set = new Set();
        arr.forEach((cqa) => {
          const ans2 = getAnswerText(cqa?.answer);
          String(ans2 || '')
            .split(/\r?\n/)
            .map((raw) => String(raw).trim())
            .filter(Boolean)
            .forEach((line) => { const { key } = parseAnswerLine(line); if (key) k3set.add(key); });
        });
        let gsum = 0;
        k3set.forEach((k3) => { gsum += (grandAnswersBySentence?.[k3]?.length || 0); });
        gMap.set(k2, gsum);
      });
    } catch (_) {}
    return { childLenMap: cMap, grandTotalMap: gMap };
  }, [childAnswersBySentence, grandAnswersBySentence]);
  // Map L1 sentence -> set of L2 keys parsed from its QA answers
  const l2KeysBySentence = useMemo(() => {
    const m = new Map();
    try {
      const obj = answersBySentence || {};
      Object.keys(obj).forEach((sent) => {
        const list = Array.isArray(obj[sent]) ? obj[sent] : [];
        const set = new Set();
        list.forEach((qa) => {
          const ans = getAnswerText(qa?.answer);
          String(ans || '')
            .split(/\r?\n/)
            .map((raw) => String(raw).trim())
            .filter(Boolean)
            .forEach((line) => { const { key } = parseAnswerLine(line); if (key) set.add(key); });
        });
        m.set(sent, set);
      });
    } catch (_) {}
    return m;
  }, [answersBySentence]);
  const renderMD = (mdText, styleObj) => (
    <Markdown style={{ body: styleObj }}>{mdText}</Markdown>
  );

  return (
    <View>
      {pieces.map((s, idx) => {
        const qaList = answersBySentence[s] || [];
        const isExpanded = !!expandedSentences[s];
        const latest = qaList[0];
        // --- Helpers to aggregate descendant counts ---
        const countL2AndL3ForKey = (k2) => {
          const c = childLenMap.get(k2) || 0;
          const g = grandTotalMap.get(k2) || 0;
          return c + g;
        };
        const totalCountL1 = useMemo(() => {
          try {
            let total = qaList.length;
            const set = l2KeysBySentence.get(s) || new Set();
            set.forEach((k2) => { total += countL2AndL3ForKey(k2); });
            return total;
          } catch (_) { return qaList.length; }
        }, [qaList, l2KeysBySentence, s, childLenMap, grandTotalMap]);

        return (
          <View key={idx} onLayout={(e) => onLayoutSentence && onLayoutSentence(s, e.nativeEvent.layout.y)}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => {
                const count = qaList.length;
                if (count > 0) { onToggleExpand(s); } else { onPressSentence(s); }
              }}
            >
              {(() => {
                // Prefer using Markdown renderer if available; still keep count badge to the right
                const baseStyle = [
                  styles.paragraphSentence,
                  s === selectedSentence && styles.selectedSentence,
                  (qaList.length > 0 && s !== selectedSentence) && styles.answeredUnderline,
                ];
                return (
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', flexShrink: 1 }}>
                    <View style={{ flex: 1, minWidth: 0 }} pointerEvents="none">{renderMD(s, baseStyle)}</View>
                    {(totalCountL1 > 0) ? (
                      <Text style={styles.countBadge}>  💬 {totalCountL1}</Text>
                    ) : null}
                  </View>
                );
              })()}
            </TouchableOpacity>

            {isExpanded && qaList.length > 0 && (
              <View style={styles.pinBlock}>
                <TouchableOpacity
                  style={styles.pinHeader}
                  onPress={undefined}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                >
                  <Text style={styles.pinIcon}>📌</Text>
                  <Text numberOfLines={2} style={styles.pinSummary}>
                    {latest?.question ? `質問: ${latest.question}` : '回答あり'}
                  </Text>
                </TouchableOpacity>

                {latest?.answer ? (
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
                                  let cnt = 0;
                                  try { cnt = Array.isArray(childAnswersBySentence?.[asKey]) ? childAnswersBySentence[asKey].length : 0; } catch {}
                                  if (cnt > 0) {
                                    onToggleNestedExpand?.(asKey);
                                  } else {
                                    onPressAnswerSentence?.(sent, baseDepth, s);
                                  }
                                }}
                                style={{ flex: 1 }}
                              >
                                {(() => { 
                                  const isOpen = !!expandedNestedSentences?.[key];
                                  const isSel = key === normalizeKey(selectedSentence);
                                  const sty = [styles.answerSentence, { paddingVertical: 4 }];
                                  const sumL2L3 = countL2AndL3ForKey(key);
                                  if (isSel) sty.push(styles.selectedAnswer || styles.selectedSentence);
                                  else if (sumL2L3 > 0) sty.push(styles.answeredUnderline);
                                  const suffix = (sumL2L3 > 0) ? (<Text style={styles.countBadge}>{'  '}💬 {sumL2L3}</Text>) : null;
                                  return (<InlineMD text={display} style={sty} suffix={suffix} />);
                                })()}
                              </TouchableOpacity>
                            </View>

                            {/* 折りたたみヒント行は置かず、行末カウントとタップで開閉 */}

                            {/* L2（child）: 最新回答行の直下に子回答を表示（縦積み） */}
                            {expandedNestedSentences?.[key] ? (
                              <View style={[styles.nestedBlock, { marginLeft: (hadBullet ? 22 : 16) }]}> 
                                {(() => { try {
                                  const list = childAnswersBySentence?.[key] || [];
                                  const first = list[0] || null;
                                  const rawQ = first && first.question;
                                  const qtext = (typeof rawQ === 'string')
                                    ? rawQ
                                    : (rawQ && typeof rawQ === 'object' && typeof rawQ.text === 'string')
                                      ? rawQ.text
                                      : '';
                                  return qtext ? (
                                    <View style={styles.nestedHeader}>
                                      <Text style={styles.nestedIcon}>💬</Text>
                                      <Text numberOfLines={2} style={styles.nestedSummary}>質問: {qtext}</Text>
                                    </View>
                                  ) : null; } catch (_) { return null; } })()}
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
                                                  let gcnt = 0;
                                                  try { gcnt = Array.isArray(grandAnswersBySentence?.[as2Key]) ? grandAnswersBySentence[as2Key].length : 0; } catch {}
                                                  if (gcnt > 0) {
                                                    onToggleGrandNestedExpand?.(as2Key);
                                                  } else {
                                                    onPressAnswerSentence?.(as2, baseDepth, s);
                                                  }
                                                }}
                                                style={{ flex: 1 }}
                                              >
                                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                                  {(() => {
                                                    let gcnt = 0; try { gcnt = Array.isArray(grandAnswersBySentence?.[as2Key]) ? grandAnswersBySentence[as2Key].length : 0; } catch {}
                                                    const gOpen = !!expandedGrandNested?.[as2Key];
                                                    const isSel = as2Key === normalizeKey(selectedSentence);
                                                    const sty = [styles.answerSentence, { paddingVertical: 4 }];
                                                    if (isSel) sty.push(styles.selectedAnswer || styles.selectedSentence);
                                                    else if (gcnt > 0) sty.push(styles.answeredUnderline);
                                                    const suffix = (gcnt > 0) ? (<Text style={styles.countBadge}>{'  '}💬 {gcnt}</Text>) : null;
                                                    return (<InlineMD text={as2} style={sty} suffix={suffix} />);
                                                  })()}
                                                </View>
                                              </TouchableOpacity>
                                            </View>

                                            {/* L3（grand）: 孫回答 */}
                                            {expandedGrandNested?.[as2Key] ? (
                                              <View style={{ marginLeft: hadBullet2 ? 22 : 16, marginTop: 4 }}>
                                                {(() => { try {
                                                  const glist = grandAnswersBySentence?.[as2Key] || [];
                                                  const gfirst = glist[0] || null;
                                                  const raw = gfirst && gfirst.question;
                                                  const gq = (typeof raw === 'string') ? raw : (raw && typeof raw === 'object' && typeof raw.text === 'string') ? raw.text : '';
                                                  return gq ? (
                                                    <View style={styles.nestedHeader}>
                                                      <Text style={styles.nestedIcon}>💬</Text>
                                                      <Text numberOfLines={2} style={styles.nestedSummary}>質問: {gq}</Text>
                                                    </View>
                                                  ) : null; } catch (_) { return null; } })()}
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
                                                            onPress={() => onPressAnswerSentence?.(as3, gqa?.depth, s)}
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
                                            ) : null}
                                          </View>
                                        );
                                      })}
                                  </View>
                                ))}
                                {/* L2 末尾のアクション行（チャットへ誘導） */}
                                <View style={{ marginTop: 8, alignItems: 'flex-start' }}>
                                  <TouchableOpacity
                                    onPress={() => {
                                      const initialText = `この記事の次の文について、さらに相談したいです。\n\n「${s}」`;
                                      try { navigation && navigation.navigate && navigation.navigate('HomeTab', { initialText }); } catch (_) {}
                                    }}
                                    accessibilityRole="button"
                                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                    activeOpacity={0.8}
                                  >
                                    <Text style={[styles.nestedToggle, { fontWeight: '700' }]}>さらに深掘りする →</Text>
                                  </TouchableOpacity>
                                </View>
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
                      onPressAnswerSentence={(ans, depth) => onPressAnswerSentence?.(ans, depth, s)}
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
