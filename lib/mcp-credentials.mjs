/**
 * Credential-reference parsing and literal-secret detection shared by the DSH
 * and Codex MCP syncers.
 *
 * A source may only name a credential through a whole `${VAR}` reference (or
 * `Bearer ${VAR}` for an Authorization header). Everything else is reported by
 * key path and label; a value itself is never returned, logged or written to a
 * host configuration. The literal shapes mirror the export guard in
 * `lib/pi_config.py` so both directions refuse the same tokens.
 */

export const REFERENCE_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER_REFERENCE_PATTERN = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const PLACEHOLDER_PATTERN = /YOUR_[A-Za-z0-9_]+/;

const SECRET_VALUE_PATTERNS = [
  ['openai-style key', /sk-[A-Za-z0-9_-]{16,}/],
  ['GitHub token', /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/],
  ['GitHub fine-grained token', /github_pat_[A-Za-z0-9_]{20,}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The variable name of a whole `${VAR}` reference, or null. */
export function credentialReference(value) {
  if (typeof value !== 'string') return null;
  return REFERENCE_PATTERN.exec(value)?.[1] ?? null;
}

/** The variable name of a `Bearer ${VAR}` reference, or null. */
export function bearerCredentialReference(value) {
  if (typeof value !== 'string') return null;
  return BEARER_REFERENCE_PATTERN.exec(value)?.[1] ?? null;
}

/** The DSH `${credential:REF}` template that resolves the referenced secret. */
export function credentialTemplate(reference) {
  return `\${credential:${reference}}`;
}

/** The DSH template for an Authorization value that keeps its scheme prefix. */
export function bearerCredentialTemplate(reference) {
  return `Bearer \${credential:${reference}}`;
}

/** Whether any string inside `value` contains a template-like `${...}`. */
export function containsTemplate(value) {
  if (typeof value === 'string') return value.includes('${');
  if (Array.isArray(value)) return value.some(containsTemplate);
  if (isObject(value)) return Object.values(value).some(containsTemplate);
  return false;
}

function walk(value, path, visit) {
  if (typeof value === 'string') {
    visit(value, path || 'value');
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) walk(item, `${path || 'value'}[${index}]`, visit);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key, visit);
}

/**
 * Literal token shapes anywhere in a server definition. Returns key paths and
 * labels only; a matching value is never part of the result.
 */
export function literalSecretsIn(value) {
  const found = [];
  walk(value, '', (text, path) => {
    for (const [label, pattern] of SECRET_VALUE_PATTERNS) {
      if (pattern.test(text)) {
        found.push({ path, label });
        break;
      }
    }
  });
  return found;
}

/** Paths whose string still carries a `YOUR_*` template placeholder. */
export function unresolvedPlaceholdersIn(value) {
  const found = [];
  walk(value, '', (text, path) => {
    if (PLACEHOLDER_PATTERN.test(text)) found.push({ path });
  });
  return found;
}

/**
 * Explain why one env/header value is not a usable reference without quoting
 * the value. `field` is a key path such as `env.TOKEN`.
 */
export function literalValueReason(field, value, { authorization = false } = {}) {
  const [secret] = literalSecretsIn(value);
  if (secret) {
    return `${field} contains a literal secret (${secret.label}); only \${VAR} references are synced`;
  }
  if (authorization) {
    return `${field} is not a credential reference; use "Bearer \${VAR}" or "\${VAR}"`;
  }
  if (typeof value === 'string' && value.includes('${')) {
    return `${field} is not a whole \${VAR} reference`;
  }
  return `${field} is a literal value; only \${VAR} references are synced`;
}
