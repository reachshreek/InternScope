window.browserWorkspace = import('./browser-workspace.js').then(module => module.createBrowserWorkspace());
document.addEventListener('click', async event => {
  const link = event.target.closest('a[href="/api/export"]');
  if (!link) return;
  event.preventDefault();
  const data = await (await window.browserWorkspace).api('/export');
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const download = document.createElement('a'); download.href = url; download.download = 'internscope-applications.json'; download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
