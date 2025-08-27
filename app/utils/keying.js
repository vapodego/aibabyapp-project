


// Normalize a key: remove leading bullets/symbols (ASCII, Japanese, common glyphs),
// collapse ASCII + full-width spaces, trim.
export function normalizeKey(s) {
  return String(s || '')
    .replace(/[\r\t]/g, ' ')
    .replace(/^[\s\u3000]*[-*•●◦‣▪■□▶▷▶︎※▲▼◆◇★☆・]+[\s\u3000]*/, '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
}

// Parse a raw answer line into { display, key }.
// "display" is the cleaned text for showing in UI, "key" is the normalized string used in state lookups.
export function parseAnswerLine(raw) {
  const line = String(raw || '').trim();
  if (!line) return { display: '', key: '' };

  // detect and strip common bullets at line start
  const m = line.match(/^[\s\u3000]*[-*•●◦‣▪■□▶▷▶︎※▲▼◆◇★☆・]\s+(.+)/);
  const display = m ? m[1] : line;
  return { display, key: normalizeKey(display) };
}