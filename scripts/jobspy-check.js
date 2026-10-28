import { spawnSync } from 'node:child_process';
import { jobSpyPython } from '../server/jobspy.js';
for (const args of [['server/jobspy_bridge.py', '--check'], ['tests/jobspy_bridge_test.py']]) {
  const child = spawnSync(jobSpyPython(), args, { windowsHide: true, shell: false, stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (child.error) { console.error(child.error.message); process.exit(1); }
  if (child.status !== 0) process.exit(child.status || 1);
}
