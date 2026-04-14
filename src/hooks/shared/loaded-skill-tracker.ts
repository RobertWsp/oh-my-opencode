const loaded = new Map<string, Set<string>>();

export function record(sessionID: string, name: string): void {
  if (!loaded.has(sessionID)) loaded.set(sessionID, new Set());
  loaded.get(sessionID)!.add(name.toLowerCase());
}

export function isLoaded(sessionID: string, name: string): boolean {
  return loaded.get(sessionID)?.has(name.toLowerCase()) ?? false;
}

export function all(sessionID: string): string[] {
  const set = loaded.get(sessionID);
  return set ? [...set] : [];
}

export function clear(sessionID: string): void {
  loaded.delete(sessionID);
}
