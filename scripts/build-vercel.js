import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/shared', { recursive: true });
cpSync('public', 'dist', { recursive: true });
for (const name of ['defaults', 'matching', 'quality', 'text', 'boards', 'posting-identity']) cpSync(`server/${name}.js`, `dist/shared/${name}.js`);
console.log('Built Vercel-only frontend. Personal data stays in browser storage.');
