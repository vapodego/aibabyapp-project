// codemod-html-fetch.js
// Usage: node codemod-html-fetch.js "<agents_dir_path>"
const fs = require('fs');
const path = require('path');

const TARGET_DIR = process.argv[2];
if (!TARGET_DIR) {
  console.error('Usage: node codemod-html-fetch.js "<agents_dir_path>"');
  process.exit(1);
}

const MIN_LENGTH_DEFAULT = 100;

function rewriteFile(filePath) {
  let src = fs.readFileSync(filePath, 'utf8');
  const before = src;

  // 1) remove node-fetch import lines
  src = src.replace(/^\s*const\s+fetch\s*=\s*require\(['"]node-fetch['"]\);\s*\n?/m, '');

  // 2) ensure toolGetHtmlContent import exists (require path: ../utils/weeklyPlannerUtils)
  const hasImport = /require\(['"]\.\.\/utils\/weeklyPlannerUtils['"]\)\s*;?/.test(src);
  if (!hasImport) {
    // 既存のutils importの直後に挿入（なければ先頭に）
    if (/require\(['"]\.\.\/utils['"]\)\s*;?/.test(src)) {
      src = src.replace(
        /(const\s+\{[^}]*\}\s*=\s*require\(['"]\.\.\/utils['"]\);\s*\n)/,
        `$1const { toolGetHtmlContent } = require('../utils/weeklyPlannerUtils');\n`
      );
    } else {
      // 先頭の 'use strict' の後、もしくはファイル先頭
      src = src.replace(
        /(^\s*['"]use strict['"];\s*\n)?/,
        (m) => `${m || ''}const { toolGetHtmlContent } = require('../utils/weeklyPlannerUtils');\n`
      );
    }
  } else {
    // 既に require されているが、toolGetHtmlContent が未破棄であることを保証
    src = src.replace(
      /const\s+\{([^}]*)\}\s*=\s*require\(['"]\.\.\/utils\/weeklyPlannerUtils['"]\);/,
      (m, g1) => {
        if (!/\btoolGetHtmlContent\b/.test(g1)) {
          return `const { ${g1.replace(/\s+$/, '')}, toolGetHtmlContent } = require('../utils/weeklyPlannerUtils');`;
        }
        return m;
      }
    );
  }

  // 3) replace fetch(...) + response handling → toolGetHtmlContent
  // パターンA: const resp = await fetch(url, {...}); const html = await resp.text(); if (!resp.ok) ...
  // ラフな正規表現で広めに対応（手元レビュー前提）
  src = src
    // kill "if (!response.ok) { ... return null; }"
    .replace(/if\s*\(\s*!\s*\w+\.ok\s*\)\s*\{[^}]*return\s+null\s*;?[^}]*\}/g, '')
    // kill "const html = await response.text();"
    .replace(/const\s+html\s*=\s*await\s*\w+\.text\(\)\s*;?/g, '')
    // replace "const response = await fetch(url[, opts])" → "const html = await toolGetHtmlContent(url, { minLength: 100 })"
    .replace(
      /const\s+\w+\s*=\s*await\s*fetch\(\s*(\w+|\S+)\s*(?:,\s*\{[^}]*\}\s*)?\)\s*;?/g,
      `const html = await toolGetHtmlContent($1, { minLength: ${MIN_LENGTH_DEFAULT} });`
    );

  // 4) ensure HTML existence check (if not already)
  // 代表的なパターン: 直後に if (!html || html.trim().length < N) { ... } が無ければ挿入
  if (/const\s+html\s*=\s*await\s*toolGetHtmlContent\([^\)]*\);\s*(?!if\s*\(\s*!html)/.test(src)) {
    src = src.replace(
      /(const\s+html\s*=\s*await\s*toolGetHtmlContent\([^\)]*\)\s*;\s*)/,
      `$1if (!html) { console.error("[Extractor Agent] HTMLが取得できない/短すぎるため、処理を中断します。"); return null; }\n`
    );
  }

  // 5) html.substring(...) が無い場合はプロンプト内での参照を補助（ここは安全のため変更しない）
  // → 各ファイルごとに既存のプロンプトが html を使う前提。必要なら手動調整。

  if (src !== before) {
    fs.writeFileSync(filePath, src, 'utf8');
    console.log(`✔ Rewrote: ${path.relative(process.cwd(), filePath)}`);
  } else {
    console.log(`(no change): ${path.relative(process.cwd(), filePath)}`);
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
    } else if (entry.isFile() && p.endsWith('.js')) {
      rewriteFile(p);
    }
  }
}

walk(TARGET_DIR);
console.log('Done.');