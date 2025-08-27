// app/components/NestedQA.js
import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { normalizeKey, parseAnswerLine } from '../utils/keying';

// Tiny inline debug badge (always rendered)
const DevBadge = ({ count = 0, expanded = false }) => {
  return (
    <Text style={{ opacity: 0.6, fontSize: 11, marginLeft: 8 }}>
      {`[c:${count}|e:${expanded ? '✓' : '×'}]`}
    </Text>
  );
};

// --- Minimal inline Markdown renderer (bold, italic, bullets, simple links) ---
export function InlineMD({ text, style }) {
  // Split into inline tokens for **bold**, *italic*, and `code`
  const parts = [];
  let rest = String(text);
  const regex = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\`[^`]+\`)|(\[[^\]]+\]\([^\)]+\))/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(rest)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: rest.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith('**')) {
      parts.push({ type: 'bold', value: token.slice(2, -2) });
    } else if (token.startsWith('*')) {
      parts.push({ type: 'italic', value: token.slice(1, -1) });
    } else if (token.startsWith('`')) {
      parts.push({ type: 'code', value: token.slice(1, -1) });
    } else if (token.startsWith('[')) {
      // [label](url)
      const m = token.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
      if (m) parts.push({ type: 'link', label: m[1], href: m[2] });
      else parts.push({ type: 'text', value: token });
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < rest.length) parts.push({ type: 'text', value: rest.slice(lastIndex) });

  return (
    <Text style={style}>
      {parts.map((p, i) => {
        if (p.type === 'bold') return <Text key={i} style={[style, { fontWeight: 'bold' }]}>{p.value}</Text>;
        if (p.type === 'italic') return <Text key={i} style={[style, { fontStyle: 'italic' }]}>{p.value}</Text>;
        if (p.type === 'code') return <Text key={i} style={[style, { fontFamily: 'Menlo' }]}>{p.value}</Text>;
        if (p.type === 'link') return <Text key={i} style={[style, { textDecorationLine: 'underline' }]}>{p.label}</Text>;
        return <Text key={i} style={style}>{p.value}</Text>;
      })}
    </Text>
  );
}

export function BlockMD({ text, style, bulletStyle }) {
  const lines = String(text).split(/\r?\n/);
  return (
    <View>
      {lines.map((line, idx) => {
        const m = line.match(/^\s*[-*]\s+(.+)/);
        if (m) {
          return (
            <View key={idx} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <Text style={[style, bulletStyle, { marginRight: 6 }]}>•</Text>
              <InlineMD text={m[1]} style={style} />
            </View>
          );
        }
        return <InlineMD key={idx} text={line} style={style} />;
      })}
    </View>
  );
}

// 一時的にこのコンポーネント内に文分割を同梱（後で utils/text に移設可能）
export function splitToSentences(raw) {
  if (!raw) return [];
  return String(raw)
    .replace(/\n+/g, '\n')
    .split(/(?<=[。！？])\s*|\n+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * ネストQ/A表示コンポーネント
 * 
 * props:
 *  - qaList: Array<{ question, answer, depth, createdAt? }>
 *  - selectedSentence: string | null
 *  - onPressAnswerSentence: (sentence: string, depth: number) => void
 *  - childAnswersBySentence: { [answerSentence: string]: Array<QA> }
 *  - expandedNestedSentences: { [answerSentence: string]: boolean }
 *  - toggleNestedExpand: (answerSentence: string) => void
 *  - grandAnswersBySentence: { [answerSentenceLv2: string]: Array<QA> }
 *  - expandedGrandNested: { [answerSentenceLv2: string]: boolean }
 *  - toggleGrandNestedExpand: (answerSentenceLv2: string) => void
 *  - styles: 親スクリーンの StyleSheet をそのまま利用
 */
export default function NestedQA({
  qaList = [],
  selectedSentence,
  onPressAnswerSentence,
  childAnswersBySentence = {},
  expandedNestedSentences = {},
  toggleNestedExpand,
  grandAnswersBySentence = {},
  expandedGrandNested = {},
  toggleGrandNestedExpand,
  styles,
  hideBase = false,
  onDebug,
}) {
  const latestRest = Math.max(((hideBase ? (qaList?.length || 0) - 1 : (qaList?.length || 0)) - 3), 0);
  // 親で最新を描画済みなら重複回避のため先頭を除外
  const renderList = hideBase ? (qaList || []).slice(1) : (qaList || []);

  return (
    <View style={styles.pinBody}>
      {renderList.slice(0, 3).map((qa, i) => (
        <View key={i} style={styles.qaItem}>
          {!hideBase && (<Text style={styles.qaQ}>Q: {qa.question}</Text>)}

          <View style={{ marginTop: 2 }}>
            {/* フル回答（Markdown簡易表示） */}
            
            {/* 文ごとのタップ（深掘り用） */}
            {String(qa.answer).split(/\r?\n/)
              .map((raw) => String(raw).trim())
              .filter(Boolean)
              .map((line, j) => {
                const { display: as, key: asKey } = parseAnswerLine(line);
                const hadBullet = as !== line;
                return (
                  <View key={j} style={{ flexDirection: 'column' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                      {hadBullet ? <Text style={[styles.answerSentence, { paddingVertical: 4, marginRight: 6 }]}>•</Text> : null}
                      <TouchableOpacity
                        activeOpacity={0.7}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel={`回答文をタップして深掘り。現在の深さは${(qa && typeof qa.depth === 'number') ? qa.depth : 1}です`}
                        onPress={() => {
                          try { console.log('[NestedQA] tap L2 sentence', { sentence: as, depth: qa?.depth }); } catch {}
                          try {
                            const childCount = Array.isArray(childAnswersBySentence?.[asKey]) ? childAnswersBySentence[asKey].length : 0;
                            const expanded = !!expandedNestedSentences?.[asKey];
                            onDebug && onDebug({ tag: 'tap-as-eval', level: 2, as, asKey, childCount, expanded });
                          } catch (_) {}
                          onPressAnswerSentence?.(as, qa?.depth);
                        }}
                        onLongPress={() => {
                          try {
                            const childCount = Array.isArray(childAnswersBySentence?.[asKey]) ? childAnswersBySentence[asKey].length : 0;
                            const expanded = !!expandedNestedSentences?.[asKey];
                            onDebug && onDebug({ tag: 'asKey-inspect', level: 2, as, asKey, childCount, expanded });
                          } catch (_) {}
                        }}
                        style={{ flex: 1 }}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                          <View style={{ flex: 1, paddingRight: 8 }}>
                            <InlineMD
                              text={as}
                              style={[
                                styles.answerSentence,
                                { paddingVertical: 4 },
                                asKey === normalizeKey(selectedSentence) && styles.selectedSentence
                              ]}
                            />
                          </View>
                          <DevBadge
                            count={Array.isArray(childAnswersBySentence?.[asKey]) ? childAnswersBySentence[asKey].length : 0}
                            expanded={!!expandedNestedSentences?.[asKey]}
                          />
                        </View>
                      </TouchableOpacity>
                    </View>

                    {/* L2 debug & L2 children placed BELOW the line (vertical stacking) */}
                    {(() => { try {
                      const childCount = Array.isArray(childAnswersBySentence?.[asKey]) ? childAnswersBySentence[asKey].length : 0;
                      const expanded = !!expandedNestedSentences?.[asKey];
                      console.log('[NestedQA] L2 render-check', { asKey, childCount, expanded });
                      onDebug && onDebug({ tag: 'render-L2', asKey, childCount, expanded, sampleKeys: Object.keys(childAnswersBySentence || {}).slice(0, 3) });
                    } catch (_) {} })()}

                    {Array.isArray(childAnswersBySentence?.[asKey]) && childAnswersBySentence[asKey].length > 0 && (expandedNestedSentences?.[asKey]) ? (
                      <View style={{ marginLeft: hadBullet ? 22 : 16, marginTop: 6 }}>
                        {childAnswersBySentence[asKey].map((cqa, m) => (
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
                                          try { console.log('[NestedQA] tap L3 sentence', { sentence: as2, depth: cqa?.depth }); } catch {}
                                          try {
                                            const grandCount = Array.isArray(grandAnswersBySentence?.[as2Key]) ? grandAnswersBySentence[as2Key].length : 0;
                                            const gExpanded = !!expandedGrandNested?.[as2Key];
                                            onDebug && onDebug({ tag: 'tap-as2-eval', level: 3, as2, as2Key, grandCount, expanded: gExpanded });
                                          } catch (_) {}
                                          onPressAnswerSentence?.(as2, cqa?.depth);
                                        }}
                                        onLongPress={() => {
                                          try {
                                            const grandCount = Array.isArray(grandAnswersBySentence?.[as2Key]) ? grandAnswersBySentence[as2Key].length : 0;
                                            const gExpanded = !!expandedGrandNested?.[as2Key];
                                            onDebug && onDebug({ tag: 'as2Key-inspect', level: 3, as2, as2Key, grandCount, expanded: gExpanded });
                                          } catch (_) {}
                                        }}
                                        style={{ flex: 1 }}
                                      >
                                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                          <View style={{ flex: 1, paddingRight: 8 }}>
                                            <InlineMD
                                              text={as2}
                                              style={[
                                                styles.answerSentence,
                                                { paddingVertical: 4 },
                                                as2Key === normalizeKey(selectedSentence) && styles.selectedSentence
                                              ]}
                                            />
                                          </View>
                                          <DevBadge
                                            count={Array.isArray(grandAnswersBySentence?.[as2Key]) ? grandAnswersBySentence[as2Key].length : 0}
                                            expanded={!!expandedGrandNested?.[as2Key]}
                                          />
                                        </View>
                                      </TouchableOpacity>
                                    </View>

                                    {/* L3 debug & grandchildren below the L3 line */}
                                    {(() => { try {
                                      const grandCount = Array.isArray(grandAnswersBySentence?.[as2Key]) ? grandAnswersBySentence[as2Key].length : 0;
                                      const gExpanded = !!expandedGrandNested?.[as2Key];
                                      console.log('[NestedQA] L3 render-check', { as2Key, grandCount, expanded: gExpanded });
                                      onDebug && onDebug({ tag: 'render-L3', as2Key, grandCount, expanded: gExpanded, sampleKeys: Object.keys(grandAnswersBySentence || {}).slice(0, 3) });
                                    } catch (_) {} })()}

                                    {Array.isArray(grandAnswersBySentence?.[as2Key]) && grandAnswersBySentence[as2Key].length > 0 && (expandedGrandNested?.[as2Key]) ? (
                                      <View style={{ marginLeft: hadBullet2 ? 22 : 16, marginTop: 4 }}>
                                        {grandAnswersBySentence[as2Key].map((gqa, t) => (
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
                                                      onPress={() => {
                                                        try { console.log('[NestedQA] tap L4 sentence', { sentence: as3, depth: gqa?.depth }); } catch {}
                                                        onPressAnswerSentence?.(as3, gqa?.depth);
                                                      }}
                                                      onLongPress={() => { try { onDebug && onDebug({ tag: 'as3Key-inspect', level: 4, as3, as3Key }); } catch (_) {} }}
                                                      style={{ flex: 1 }}
                                                    >
                                                      <InlineMD
                                                        text={as3}
                                                        style={[styles.answerSentence, { paddingVertical: 4 }, as3Key === normalizeKey(selectedSentence) && styles.selectedSentence]}
                                                      />
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
                      </View>
                    ) : null}
                  </View>
                );
              })}
          </View>
        </View>
      ))}

      {latestRest > 0 && <Text style={styles.pinMore}>さらに{latestRest}件…</Text>}
    </View>
  );
}