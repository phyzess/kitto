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
 * A name that reads as a credential slot: query parameter, header-like flag or
 * env assignment. Segment-aware so `?monkey=1` is not mistaken for a key.
 */
export function isCredentialName(name) {
  const folded = String(name).toLowerCase();
  if (/(?:token|secret|password|passwd|credential|bearer|authorization)/.test(folded)) return true;
  if (/(?:api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret)/.test(folded)) return true;
  if (/(?:^|[-_.])(?:auth|sig|signature)(?:$|[-_.])/.test(folded)) return true;
  return /(?:^|[-_.])key(?:$|[-_.])/.test(folded);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function queryCredentialReason(text) {
  for (const match of text.matchAll(/[?&;#]([^=&;#\s]+)=/g)) {
    if (isCredentialName(safeDecode(match[1]))) return 'has a credential-like query parameter';
  }
  return null;
}

/**
 * Why a URL must not be copied literally, or null. Rejects any userinfo
 * (`user:pass@host`) and credential-like query or fragment parameters, which
 * are a common carrier for literal tokens. The URL itself is never returned.
 */
export function urlCredentialReason(value) {
  if (typeof value !== 'string' || value === '') return null;
  // Authority userinfo, including strings another parser might reject later.
  if (/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s]*@/.test(value)) return 'contains userinfo credentials';
  const fromText = queryCredentialReason(value);
  if (fromText) return fromText;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return 'contains userinfo credentials';
    for (const [name] of parsed.searchParams) {
      if (isCredentialName(name)) return 'has a credential-like query parameter';
    }
    for (const part of parsed.hash.replace(/^#/, '').split(/[&;]/)) {
      const name = part.split('=')[0];
      if (name && isCredentialName(safeDecode(name))) return 'has a credential-like query parameter';
    }
  } catch {
    // Relative values were already covered by the textual query scan.
  }
  return null;
}

const FLAG_PATTERN = /^(?:--?|\/)([A-Za-z0-9][A-Za-z0-9_.-]*)(?:=(.*))?$/;
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const ASSIGNMENT_PAIR = /(?:^|[\s,;])([A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*)\s*[:=]\s*(\S+)/g;
const HEADER_FLAG_NAMES = new Set(['header', 'headers', 'http-header']);

function valueLooksCredentialLike(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (literalSecretsIn(value).length) return true;
  if (/^Bearer\s+\S+/i.test(value)) return true;
  // A long unbroken token-like value in a header is treated as a secret.
  return value.length >= 20 && /^[A-Za-z0-9+/_=-]+$/.test(value);
}

/**
 * Inspect one `Name: value` header specification. Sensitive header names and
 * credential-looking values are refused; the specification is never echoed.
 */
function headerSpecProblem(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return null;
  const separator = spec.search(/[:=]/);
  let name, value;
  if (separator >= 0) {
    name = spec.slice(0, separator).trim();
    value = spec.slice(separator + 1).trim();
  } else {
    const [first, ...rest] = spec.trim().split(/\s+/);
    name = first;
    value = rest.join(' ');
  }
  if (isCredentialName(name)) return 'looks like a sensitive header';
  if (value && valueLooksCredentialLike(value)) return 'looks like a credential header value';
  return null;
}

function headerFlagMatch(value) {
  const match = FLAG_PATTERN.exec(value);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const header = (match[1] === 'H' && value.startsWith('-H')) || HEADER_FLAG_NAMES.has(name);
  return header ? match : null;
}

/** A `name=value` / `name: value` token whose name reads as a credential. */
function assignmentLooksLikeCredential(value) {
  for (const match of value.matchAll(ASSIGNMENT_PAIR)) {
    if (match[2] !== '' && isCredentialName(match[1])) return true;
  }
  return false;
}

function credentialFlagIsLiteral(value) {
  const match = FLAG_PATTERN.exec(value);
  if (!match) return false;
  if (typeof match[2] === 'string') {
    if (/authorization\s*:/i.test(match[2]) || /\bbearer\s+[^$\s]/i.test(match[2])) return true;
    const assigned = ENV_ASSIGNMENT.exec(match[2]);
    if (assigned && assigned[2] !== '' && isCredentialName(assigned[1])) return true;
    if (assignmentLooksLikeCredential(match[2])) return true;
  }
  return isCredentialName(match[1]) && typeof match[2] === 'string' && match[2] !== '';
}

function tokenLooksLikeCredential(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (credentialFlagIsLiteral(value)) return true;
  const assigned = ENV_ASSIGNMENT.exec(value);
  if (assigned && assigned[2] !== '' && isCredentialName(assigned[1])) return true;
  if (/authorization\s*:/i.test(value)) return true;
  if (/\bbearer\s+[^$\s]/i.test(value)) return true;
  if (assignmentLooksLikeCredential(value)) return true;
  return false;
}

/**
 * A literal credential in a transport that Kitto would otherwise copy into a
 * host configuration: URL userinfo/query, a credential-shaped command flag or
 * env assignment, or a literal Authorization/Bearer value. Returns a path-only
 * reason so a failing command can be reported without echoing its argv.
 */
export function transportCredentialProblem(entry) {
  if (!isObject(entry)) return null;
  if (typeof entry.url === 'string') {
    const reason = urlCredentialReason(entry.url);
    if (reason) return `url ${reason}`;
  }
  const tokens = [];
  if (typeof entry.command === 'string') tokens.push({ path: 'command', value: entry.command });
  if (Array.isArray(entry.args)) {
    for (const [index, value] of entry.args.entries()) {
      if (typeof value === 'string') tokens.push({ path: `args[${index}]`, value });
    }
  }
  for (const [index, token] of tokens.entries()) {
    const reason = urlCredentialReason(token.value);
    if (reason) return `${token.path} ${reason}`;
    const header = headerFlagMatch(token.value);
    if (header) {
      const spec = header[2] ?? tokens[index + 1]?.value;
      const specPath = header[2] === undefined ? tokens[index + 1]?.path ?? token.path : token.path;
      if (spec !== undefined) {
        const problem = headerSpecProblem(spec);
        if (problem) return `${specPath} ${problem}`;
      }
    }
    if (tokenLooksLikeCredential(token.value)) return `${token.path} looks like a literal credential`;
    const previous = tokens[index - 1];
    if (previous && !token.value.startsWith('-') && isCredentialFlag(previous.value)) {
      return `${token.path} looks like a literal credential`;
    }
    const next = tokens[index + 1];
    if (next && isCredentialFlag(token.value) && !next.value.startsWith('-')) {
      return `${next.path} looks like a literal credential`;
    }
  }
  return null;
}

function isCredentialFlag(value) {
  const match = FLAG_PATTERN.exec(value);
  return Boolean(match && isCredentialName(match[1]));
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
