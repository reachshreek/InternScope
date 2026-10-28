import { boardFromUrl } from './boards.js';

// Public ATS APIs require a company board identifier; none provides a global board index.
// Build a growing catalog from job URLs in the community feed, including historical entries.
export function discoverBoards(rows) {
  const boards = new Map();
  const ordered = [...rows].sort((a,b) => Number(b.active !== false) - Number(a.active !== false) || (Number(b.date_posted) || 0) - (Number(a.date_posted) || 0));
  for (const row of ordered) {
    try {
      const board = boardFromUrl(row.url);
      if (!board) continue;
      const { kind, token } = board;
      const key = `${kind}:${token.toLowerCase()}`;
      if (!boards.has(key)) boards.set(key, { kind, token, name: String(row.company_name || row.company || token).slice(0, 100) });
    } catch { /* Non-job URLs never become request targets. */ }
  }
  return [...boards.values()];
}
