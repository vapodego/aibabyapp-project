


// app/utils/keying.js
// 共通のキー正規化ロジック（表示は保持しつつ、比較用キーは強く正規化）
// - NFKC 正規化（全角/半角のゆらぎ吸収）
// - Markdown/箇条書きのプレフィックス除去
// - 句読点・記号を除去
// - 空白を除去
// - 小文字化

/** 先頭の箇条書きプレフィックスを除去（表示用テキストは別で保持） */
export function stripListPrefix(input) {
  if (!input) return '';
  const s = String(input).trim();
  return s
    .replace(/^(\s*[-*•・‣▪◦●○▲■□◆◇・]|^\s*\d+[.)]|\s*【\d+】)\s*/u, '')
    .replace(/^\s+/u, '');
}

/** 比較用の強力な正規化キーを返す */
export function normalizeKey(input) {
  if (input == null) return '';
  let s = String(input);

  // 1) Unicode 正規化
  s = s.normalize('NFKC');

  // 2) 先頭のリスト記号は落とす
  s = stripListPrefix(s);

  // 3) Markdown 装飾記号を除去
  s = s.replace(/[#*_`~>|[\]()+-]/gu, '');

  // 4) 句読点・記号を除去
  s = s
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/[、。・‥…，．？！：；「」『』（）［］｛｝〈〉《》【】]/gu, '');

  // 5) 空白除去
  s = s.replace(/\s+/gu, '').replace(/[\u3000]/gu, '');

  // 6) 小文字化
  s = s.toLowerCase();

  return s;
}

/**
 * 回答1行を「表示テキスト」と「比較用キー」に分解して返す。
 */
export function parseAnswerLine(rawLine) {
  const raw = String(rawLine ?? '').trim();
  const display = stripListPrefix(raw);
  const key = normalizeKey(display);
  return { display, key };
}