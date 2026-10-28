export function plainText(value = '') {
  let text = String(value);
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  for (let n = 0; n < 2; n++) text = text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, key) => {
    if (key[0] !== '#') return entities[key.toLowerCase()] ?? all;
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/\r/g, '').replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function resumeText(input) {
  let raw = String(input);
  if (/\\(?:documentclass|begin|section|textbf|item)\b/.test(raw)) raw = raw.replace(/(?<!\\)%[^\n]*/g, '');
  return plainText(raw
    .replace(/\\(?:documentclass|usepackage|pagestyle|setlength|definecolor|newcommand)\b[^\n]*/g, '')
    .replace(/\\(?:begin|end)\{[^}]+\}(?:\[[^\]]*\])?/g, '\n')
    .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1')
    .replace(/\\(?:textbf|textit|emph|section\*?|subsection\*?|underline)\{([^}]*)\}/g, '\n$1\n')
    .replace(/\\(?:item|newline|par)\b|\\\\/g, '\n')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/[{}]/g, ' ').replace(/\\([&%_$#])/g, '$1'));
}

export function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|gh_src$|lever-source$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

export function isoDate(value) {
  if (!value) return null;
  const date = new Date(typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : value);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 86400000) return null;
  return date.toISOString();
}
