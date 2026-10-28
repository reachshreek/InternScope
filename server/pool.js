// Keep unrelated hosts moving when one host is busy. Workers may add discovered work.
export function runPool(items, worker, { concurrency, key = () => '', perKey = concurrency, stopped = () => false }) {
  const pending = [], hosts = new Map();
  let active = 0, failure;
  return new Promise((resolve, reject) => {
    const add = items => pending.push(...items.map(item => ({ item, host: key(item), limit: typeof perKey === 'function' ? perKey(item) : perKey })));
    function pump() {
      while (!failure && !stopped() && active < concurrency) {
        const index = pending.findIndex(({ host, limit }) => (hosts.get(host) || 0) < limit);
        if (index < 0) break;
        const [{ item, host }] = pending.splice(index, 1);
        active++; hosts.set(host, (hosts.get(host) || 0) + 1);
        Promise.resolve().then(() => worker(item, add)).catch(error => { failure ||= error; }).finally(() => {
          active--; hosts.set(host, hosts.get(host) - 1); pump();
        });
      }
      if (!active) failure ? reject(failure) : resolve();
    }
    add(items); pump();
  });
}
