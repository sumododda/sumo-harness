/** Memoizes an async lookup per key. */

const cache = new Map();

export function memoizeAsync(fn) {
  return async function (key) {
    if (cache.has(key)) return cache.get(key);
    // Bug: awaits before caching, so concurrent calls for the same key each
    // start their own underlying call instead of sharing the one in flight.
    const value = await fn(key);
    cache.set(key, value);
    return value;
  };
}

export function resetCache() {
  cache.clear();
}
