// Internal display placeholders, never user identities. The unusual delimiters
// avoid replacing ordinary words, short usernames, or overlapping names inside
// notifications. They have no effect on team assignment or simulation hashes.
export function anonymousSimulationName(index: number): string {
  return `\uE000if:${index}\uE001`;
}

export const ANONYMOUS_SIMULATION_NAME = /\uE000if:(\d+)\uE001/g;
