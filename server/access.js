import { createHash, timingSafeEqual } from 'node:crypto';

export function workspaceAccess({ username = process.env.WORKSPACE_USER, password = process.env.WORKSPACE_PASSWORD, required = process.env.REQUIRE_AUTH === '1' } = {}) {
  if ((required || username || password) && (!username || !password)) throw new Error('Set both WORKSPACE_USER and WORKSPACE_PASSWORD for the private hosted workspace.');
  const digest = value => createHash('sha256').update(value).digest();
  const expected = username && digest(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  return (req, res, next) => {
    if (!expected || (req.method === 'GET' && req.path === '/api/health')) return next();
    if (timingSafeEqual(expected, digest(req.headers.authorization || ''))) return next();
    res.set({ 'WWW-Authenticate': 'Basic realm="Internscope", charset="UTF-8"', 'Cache-Control': 'no-store' });
    res.status(401).json({ error: 'Sign in to your private workspace.' });
  };
}
