import picomatch from "picomatch/posix";
const compiled = new Map<string, (path: string) => boolean>();
/** One include/exclude glob per line; exclusions always win. These only narrow a declared selector. */
export function filePatternMatcher(source: string) {
  if (source.length > 8192) throw Error("File patterns are too long");
  const cached = compiled.get(source);
  if (cached) return cached;
  const rules = source
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (rules.length > 100 || rules.some((p) => p.length > 512))
    throw Error("Use at most 100 patterns of 512 characters");
  const positive = rules.filter(
      (p) => !p.startsWith("!") || p.startsWith("!("),
    ),
    negative = rules
      .filter((p) => p.startsWith("!") && !p.startsWith("!("))
      .map((p) => p.slice(1));
  const options = { dot: true, posix: true, strictBrackets: true };
  const includes = positive.map((p) => picomatch(p, options)),
    excludes = negative.map((p) => picomatch(p, options));
  const match = (path: string) =>
    (!includes.length || includes.some((m) => m(path))) &&
    !excludes.some((m) => m(path));
  if (compiled.size > 200) compiled.clear();
  compiled.set(source, match);
  return match;
}
