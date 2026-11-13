type Compact<T> = { [K in keyof T]?: NonNullable<T[K]> };

/** Drops `null`, `undefined` and `""` (Medusa customer fields are nullable); `undefined` when empty. */
export function compact<T extends object>(value: T): Compact<T> | undefined {
  const entries = Object.entries(value).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  return entries.length ? (Object.fromEntries(entries) as Compact<T>) : undefined;
}

export function fullName(first?: string | null, last?: string | null): string | undefined {
  return [first, last].filter(Boolean).join(" ") || undefined;
}
