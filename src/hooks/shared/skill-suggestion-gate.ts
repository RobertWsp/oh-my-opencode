const gates = new Map<string, string>();

export function reset(sessionID: string): void {
  gates.delete(sessionID);
}

export function acquire(sessionID: string, source: string): boolean {
  if (gates.has(sessionID)) return false;
  gates.set(sessionID, source);
  return true;
}

export function owner(sessionID: string): string | undefined {
  return gates.get(sessionID);
}

export function clear(sessionID: string): void {
  gates.delete(sessionID);
}
