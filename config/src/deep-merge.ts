/** Rekurzív Partial — a tenant-fájlok csak az eltéréseket adják meg. */
export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Mély összefésülés: a `source` (tenant) felülírja a `base` (default) értékeit.
 * Sima objektumokat rekurzívan fésül, tömböket és primitíveket cserél.
 */
export function deepMerge<T>(base: T, source: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(source)) {
    return (source as T) ?? base;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const baseValue = (base as Record<string, unknown>)[key];
    out[key] =
      isPlainObject(baseValue) && isPlainObject(value)
        ? deepMerge(baseValue, value as DeepPartial<typeof baseValue>)
        : value;
  }
  return out as T;
}
