/**
 * Whether two plain values are the same, field for field: the same own keys in the same order (an array's named
 * keys and holes included), each as enumerable, and values that are the same in turn, with primitives compared by
 * `Object.is`. A key holding `undefined` is not the same as a missing key, and `-0` is not `0`. Anything but a
 * plain object or array is only ever the same as itself.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const proto = Object.getPrototypeOf(a);
  if (proto !== Object.getPrototypeOf(b)) return false;
  const array = Array.isArray(a);
  if (array !== Array.isArray(b)) return false;
  if (!array && proto !== Object.prototype && proto !== null) return false;
  if (array && (a as unknown[]).length !== (b as unknown[]).length) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  // Every own key enumerable (an array's length aside) and no symbols: the keys above are all there is.
  const plain = (o: object, keys: string[]) => Reflect.ownKeys(o).length === keys.length + (array ? 1 : 0);
  if (!plain(a, ka) || !plain(b, kb)) return sameOwn(a, b);
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (k !== kb[i] || !sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** The slow path, for objects with hidden or symbol keys: every own key, its kind and flags, and its value. */
function sameOwn(a: object, b: object): boolean {
  const ka = Reflect.ownKeys(a);
  const kb = Reflect.ownKeys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    const da = Reflect.getOwnPropertyDescriptor(a, ka[i])!;
    const db = Reflect.getOwnPropertyDescriptor(b, kb[i])!;
    if (da.enumerable !== db.enumerable || da.writable !== db.writable || da.configurable !== db.configurable || da.get !== db.get || da.set !== db.set) return false;
    if ('value' in da && !sameValue(da.value, db.value)) return false;
  }
  return true;
}
