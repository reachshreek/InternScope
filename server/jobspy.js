import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const JOBSPY_KINDS = ['indeed', 'ziprecruiter'];
export const jobSpyEnabled = () => process.env.JOBSPY_ENABLED !== '0';
export function jobSpyPython() {
  if (process.env.JOBSPY_PYTHON) return process.env.JOBSPY_PYTHON;
  const local = join(root, '.tools', 'jobspy', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return existsSync(local) ? local : process.platform === 'win32' ? 'python' : 'python3';
}
export function jobSpyInput(kind, queries, { resultsWanted = process.env.JOBSPY_RESULTS || 60, country = process.env.JOBSPY_COUNTRY || 'USA', remoteOnly = false } = {}) {
  if (!JOBSPY_KINDS.includes(kind)) throw new Error('Unsupported JobSpy source.');
  return { kind, queries: queries.slice(0, 6).map(query => ({ keywords: String(query.keywords || 'internship').slice(0,512), location: String(query.location || '').slice(0,200) })),
    resultsWanted: Math.max(1, Math.min(200, Number(resultsWanted) || 60)), country: String(country).slice(0,60), remoteOnly: !!remoteOnly };
}
export function runJobSpy(input, { python = jobSpyPython(), spawnProcess = spawn, timeoutMs = Number(process.env.JOBSPY_TIMEOUT_SECONDS || 180) * 1000, maxBytes = 30_000_000 } = {}) {
  return new Promise((done, reject) => {
    // Keep unrelated service credentials and proxy configuration out of the worker.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/i.test(key)));
    Object.assign(env, { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' });
    let child;
    try { child = spawnProcess(python, ['-u', join(root,'server','jobspy_bridge.py')], { cwd: root, windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe'], env }); }
    catch { reject(new Error('JobSpy could not start. Run Setup-JobSpy.ps1 or configure JOBSPY_PYTHON.')); return; }
    const rows = [], warnings = [], failures = [];
    let buffer = '', bytes = 0, completed = false, settled = false, timer, interrupted = false;
    function finish(error) {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error && !rows.length) reject(error);
      else done({ rows, warnings: [...new Set([...warnings, ...failures, ...(error ? [error.message] : [])])], partial: !!error || !!failures.length });
    }
    function event(line) {
      if (!line.trim()) return;
      let value;
      try { value = JSON.parse(line); } catch { interrupted = true; child.kill(); finish(new Error('JobSpy returned an invalid response.')); return; }
      if (!value || typeof value !== 'object' || !['query','error','complete'].includes(value.type)) { interrupted = true; child.kill(); finish(new Error('JobSpy returned an invalid response.')); return; }
      if (value.type === 'query') {
        if (!Array.isArray(value.rows) || value.rows.length > 200 || rows.length + value.rows.length > 1200) { child.kill(); finish(new Error('JobSpy exceeded the result limit.')); return; }
        rows.push(...value.rows);
        warnings.push(...(Array.isArray(value.warnings) ? value.warnings.slice(0,10).map(v => String(v).slice(0,500)) : []));
        if (value.error) failures.push(`JobSpy: ${String(value.error).slice(0,500)}`);
      } else if (value.type === 'error') failures.push(String(value.error || 'JobSpy failed.').slice(0,500));
      else if (value.type === 'complete') completed = true;
    }
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { interrupted = true; child.kill(); finish(new Error('JobSpy exceeded the response size limit; completed queries were kept.')); return; }
      buffer += chunk.toString('utf8');
      let newline;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0,newline); buffer = buffer.slice(newline+1); event(line); }
    });
    child.stderr.on('data', () => {}); // Drain library diagnostics; never mix them with results.
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('JobSpy Python runtime was not found or could not start. Run Setup-JobSpy.ps1 or configure JOBSPY_PYTHON.')));
    child.on('close', code => {
      if (buffer.trim() && !settled) event(buffer);
      const failed = code !== 0 || !completed || failures.length || interrupted;
      finish(failed ? new Error(failures[0] || 'JobSpy stopped before the search completed; completed queries were kept.') : null);
    });
    timer = setTimeout(() => { interrupted = true; child.kill(); finish(new Error('JobSpy search timed out; completed queries were kept.')); }, Math.max(1000, Math.min(300000, Number(timeoutMs) || 180000)));
    child.stdin.end(JSON.stringify(input));
  });
}
