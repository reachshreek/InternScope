// Read PDF text in the browser so uploads do not depend on native server bindings.
export async function readPdfResume(file) {
  if (file.size > 4 * 1024 * 1024) throw new Error('Choose a file under 4 MB.');
  const pdfjs = await import('./vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false,
    cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href, cMapPacked: true,
    standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href });
  try {
    const pdf = await task.promise, pages = [];
    for (let number = 1; number <= Math.min(15, pdf.numPages); number++) {
      const page = await pdf.getPage(number), content = await page.getTextContent();
      pages.push(content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''));
    }
    const resume = pages.join('\n\n').trim();
    if (resume.length < 40) throw new Error('Could not read enough resume text. For a scanned PDF, paste its text instead.');
    if (resume.length > 100000) throw new Error('Resume is too long. Please keep it under 100,000 characters.');
    return { resume, resumeName: file.name.slice(0, 200) };
  } finally { await task.destroy(); }
}
