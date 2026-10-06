/** English names for ISO 3166-1 region codes, from the runtime's own CLDR data (no table to keep in step). */
const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

/**
 * The country or region a code stands for ("CO" is "Colombia", "419" is "Latin America"), or undefined when the code is
 * unknown or reserved, so an odd value from a device never changes the prompt in a surprising way.
 */
export function regionName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  try {
    const name = names.of(code);
    // "ZZ" is CLDR's "Unknown Region"; "EU" and "UN" are not places a person lives.
    if (!name || /^unknown/i.test(name) || code === "ZZ" || code === "UN" || code === "EU" || code === "EZ") return undefined;
    return name;
  } catch {
    return undefined;
  }
}
