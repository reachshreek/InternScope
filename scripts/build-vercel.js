import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/shared', { recursive: true });
cpSync('public', 'dist', { recursive: true });
for (const name of ['defaults', 'matching', 'quality', 'text', 'boards', 'posting-identity', 'workday-metadata']) cpSync(`server/${name}.js`, `dist/shared/${name}.js`);
mkdirSync('dist/vendor', { recursive: true });
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) cpSync(`node_modules/pdfjs-dist/build/${name}`, `dist/vendor/${name}`);
for (const name of ['cmaps', 'standard_fonts']) cpSync(`node_modules/pdfjs-dist/${name}`, `dist/vendor/${name}`, { recursive: true });
cpSync('node_modules/pdfjs-dist/LICENSE', 'dist/vendor/PDFJS-LICENSE');
console.log('Built Vercel-only frontend. Personal data stays in browser storage.');
