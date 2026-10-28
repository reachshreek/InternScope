import { PDFParse } from 'pdf-parse';
import { unzipSync, strFromU8 } from 'fflate';
import { extname } from 'node:path';
import { resumeText } from './text.js';

export async function parseResume(file) {
  const ext = extname(file.originalname).toLowerCase();
  let text;
  if (ext === '.pdf') {
    if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('This file is not a valid PDF.');
    const parser = new PDFParse({ data: new Uint8Array(file.buffer), isEvalSupported: false });
    try { text = (await parser.getText({ first: 15 })).text; }
    finally { await parser.destroy(); }
  } else if (ext === '.docx') {
    if (file.buffer.subarray(0, 2).toString() !== 'PK') throw new Error('This file is not a valid DOCX.');
    const files = unzipSync(file.buffer, { filter: entry => {
      if (entry.name !== 'word/document.xml') return false;
      if (entry.originalSize > 10 * 1024 * 1024) throw new Error('The DOCX document expands beyond the size limit.');
      return true;
    } });
    if (!files['word/document.xml']) throw new Error('This DOCX has no readable document body.');
    text = strFromU8(files['word/document.xml'])
      .replace(/<w:(?:br|cr)\b[^>]*\/?\s*>/g, '\n').replace(/<w:tab\b[^>]*\/?\s*>/g, ' ')
      .replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  } else if (['.txt', '.md', '.tex', '.html', '.htm', '.json', '.jsx', '.tsx'].includes(ext)) {
    text = resumeText(file.buffer.toString('utf8'));
  } else throw new Error('Choose a PDF, DOCX, text, Markdown, LaTeX, HTML, JSON, JSX, or TSX file.');
  if (!text || text.trim().length < 40) throw new Error('Could not read enough resume text. For a scanned PDF, paste its text instead.');
  if (text.length > 100000) throw new Error('Resume is too long. Please keep it under 100,000 characters.');
  return text.trim();
}
