// Control secrets travel through Compose interpolation as sentinels that the agent replaces with the node's released
// value when it creates the container. Kept apart from normalize.ts so the validator can read them without a cycle.
const SECRET_NAME = '[A-Za-z_][A-Za-z0-9_]*';
const SENTINEL = new RegExp(`@@tug:secret:(${SECRET_NAME})@@`, 'g');

export const secretSentinel = (name: string): string => `@@tug:secret:${name}@@`;

/** Names of the control secrets that `value` references through sentinels, in order of appearance. */
export function sentinelNames(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === 'string') for (const m of v.matchAll(SENTINEL)) names.add(m[1]);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return [...names];
}

/** `value` with every sentinel replaced by the secret's value; a sentinel with no value becomes empty. */
export function substituteSentinels(value: string, secrets: Record<string, string>): string {
  return value.replace(SENTINEL, (_all, name: string) => secrets[name] ?? '');
}
