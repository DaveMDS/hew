/**
 * Name ordering shared by the panels that list things by name (Materials,
 * Components, Tags, and the Outliner's Name sort): case-insensitive,
 * locale-aware, and numeric, so "Group 2" comes before "Group 10" and
 * "apple" sits beside "Apple".
 */
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Compare two display names for sorting. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b)
}
