const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const numeric = /^\d+$/;

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = versionPattern.exec(value);
  if (!match || match[0] !== value) return null;
  const [, major, minor, patch, suffix, build] = match;
  const prerelease = suffix?.split('.') ?? [];
  if (prerelease.some(part => numeric.test(part) && part.length > 1 && part[0] === '0')) return null;
  return { core: [major, minor, patch], prerelease, build };
}

// Pins accept canonical releases/prereleases, not build metadata, tags or ranges.
export function isExactPin(value) {
  const parsed = parseVersion(value);
  return parsed !== null && parsed.build === undefined;
}

export function readVersion(output) {
  // Validate the whole version-looking token rather than silently dropping a bad suffix.
  const candidate = output?.match(/(?:^|[\s(])v?(\d+\.\d+\.\d+[^\s)]*)/)?.[1];
  return parseVersion(candidate) ? candidate : null;
}

const compareText = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const compareNumeric = (a, b) => compareText(a.length, b.length) || compareText(a, b);

/** Compare canonical SemVer strings (ignoring build metadata), or return null for invalid input. */
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const order = compareNumeric(left.core[i], right.core[i]);
    if (order) return order;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (!left.prerelease.length && !right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.min(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i], y = right.prerelease[i];
    const xNumeric = numeric.test(x), yNumeric = numeric.test(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    const order = xNumeric ? compareNumeric(x, y) : compareText(x, y);
    if (order) return order;
  }
  return compareText(left.prerelease.length, right.prerelease.length);
}

export function meetsBaseline(actual, baseline) {
  const normalize = value => typeof value === 'string' ? value.trim().replace(/^v/, '') : value;
  const order = compareVersions(normalize(actual), normalize(baseline));
  return order !== null && order >= 0;
}
