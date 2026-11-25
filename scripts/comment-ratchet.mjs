import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lexer, parseAllDocuments, visit } from 'yaml';

const version = '0.43.0';
const root = fileURLToPath(new URL('../', import.meta.url));
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const limit = 32 * 1024 * 1024;

export function decode(bytes) {
  return utf8.decode(bytes);
}

export function command(bin, args, { cwd = root, input, emptyMatch = false, rejectStderr = false } = {}) {
  const result = spawnSync(bin, args, { cwd, input, timeout: 15_000, maxBuffer: limit });
  const noMatch = emptyMatch && result.status === 1 && !result.stderr?.length && result.stdout?.toString().trim() === '[]';
  if (result.error || (result.status !== 0 && !noMatch) || (rejectStderr && result.stderr?.length)) {
    const stderr = result.stderr?.toString().trim();
    throw new Error(`${bin} ${args[0]} failed (${result.error?.message ?? result.signal ?? result.status})${stderr ? `: ${stderr}` : ''}`);
  }
  return result.stdout;
}

export function nativeParser() {
  const { platform, arch } = process;
  const target = (arch === 'x64' || arch === 'arm64') && (
    platform === 'darwin' ? `${platform}-${arch}` :
      platform === 'linux' && process.report.getReport().header.glibcVersionRuntime ? `${platform}-${arch}-gnu` : null
  );
  if (!target) throw new Error(`Unsupported ast-grep platform: ${platform}/${arch} (requires glibc on Linux)`);
  const name = `@ast-grep/cli-${target}`;
  const core = new URL('../node_modules/@ast-grep/cli/package.json', import.meta.url);
  const manifest = new URL(`../node_modules/${name}/package.json`, import.meta.url);
  const bin = fileURLToPath(new URL('ast-grep', manifest));
  try {
    const parent = JSON.parse(readFileSync(core));
    const child = JSON.parse(readFileSync(manifest));
    if (parent.name !== '@ast-grep/cli' || parent.version !== version || parent.optionalDependencies?.[name] !== version ||
        child.name !== name || child.version !== version || decode(command(bin, ['--version'])).trim() !== `ast-grep ${version}`) {
      throw new Error(`Expected @ast-grep/cli and ${name} at version ${version}`);
    }
  } catch (error) {
    throw new Error(`Pinned parser unavailable; run npm ci --ignore-scripts (${error.message})`);
  }
  return bin;
}

function ast(bin, language, kind, bytes) {
  const result = JSON.parse(command(bin, ['run', '--stdin', '--lang', language, '--kind', kind, '--json=compact'], {
    input: bytes, cwd: dirname(bin), emptyMatch: true,
  }));
  if (!Array.isArray(result)) throw new Error('Invalid parser response');
  return result.map(({ range, text, language: parsedLanguage }) => {
    const { start, end } = range.byteOffset;
    if (parsedLanguage !== language || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 ||
        end < start || end > bytes.length || decode(bytes.subarray(start, end)) !== text) {
      throw new Error(`Invalid ${language} ${kind} source range`);
    }
    return { start, end, text };
  }).sort((a, b) => a.start - b.start || b.end - a.end);
}

function lines(bytes) {
  const result = [];
  for (let start = 0; start < bytes.length;) {
    const lf = bytes.indexOf(10, start);
    const next = lf < 0 ? bytes.length : lf + 1;
    const end = lf < 0 ? next : lf;
    result.push({ start, end, next, text: decode(bytes.subarray(start, end)) });
    start = next;
  }
  return result;
}

function position(bytes, rows, offset) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].start <= offset) lo = mid + 1;
    else hi = mid;
  }
  const row = rows[lo - 1];
  if (!row || (offset === bytes.length && bytes.at(-1) === 10)) return { line: rows.length + 1, column: 1 };
  return { line: lo, column: [...decode(bytes.subarray(row.start, offset))].length + 1 };
}

function span(bytes, rows, start, end) {
  return { byteStart: start, byteEnd: end, start: position(bytes, rows, start), end: position(bytes, rows, end) };
}

function location(text, start) {
  if (start === 0 && text.startsWith('#!')) return 'shebang';
  if (/^(?:\/\/|\/\*+|#)\s*(?:@ts-(?:check|nocheck|ignore|expect-error)\b|(?:eslint|prettier|shellcheck|ruff|isort|fmt|istanbul|c8)[- :]|(?:type:\s*ignore|noqa)\b|SPDX-License-Identifier:|[#@]\s*source(?:Mapping)?URL\s*=)/u.test(text) ||
      /^#.*coding\s*[:=]\s*[-\w.]+/u.test(text) || /^\/\/\/\s*<reference\b/u.test(text)) return 'directive';
  return 'comment';
}

function completeTree(bin, language, bytes) {
  if (bytes.length > 96 * 1024) throw new Error(`${language} full-tree check exceeds the supported source size`);
  const result = spawnSync(bin, ['run', '--stdin', '--lang', language, '--debug-query=sexp', `--pattern=${decode(bytes)}`], {
    cwd: dirname(bin), input: '', timeout: 15_000, maxBuffer: limit, encoding: 'utf8',
  });
  const tree = result.stderr?.match(/^Debug Sexp:\r?\n(\([^\r\n]*\))\r?\n/u)?.[1];
  if (result.error || ![0, 1, 8].includes(result.status) || !tree) throw new Error(`${language} full-tree check failed`);
  if (/\((?:ERROR|MISSING)(?=[\s)])/u.test(tree)) throw new Error(`${language} parse error: incomplete or recovered syntax`);
  return tree;
}

function guardYaml(text) {
  const fail = message => { throw new Error(`Yaml parse error: ${message}`); };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F\uFFFE\uFFFF]/u.test(text)) {
    fail('Non-printable source character');
  }
  for (const token of new Lexer().lex(text)) {
    if (/^[ \t]+$/u.test(token) && token.includes('\t')) fail('Use spaces for YAML separation');
  }
  for (const doc of parseAllDocuments(text, { strict: true, uniqueKeys: true, prettyErrors: false })) {
    const diagnostic = doc.errors[0] ?? doc.warnings.find(warning => warning.code !== 'TAG_RESOLVE_FAILED');
    if (diagnostic) fail(`${diagnostic.code}: ${diagnostic.message}`);
    visit(doc, {
      Alias(_key, value) {
        if (!value.resolve(doc)) fail('Alias does not reference a preceding anchor');
      },
      Scalar(_key, node) {
        if (typeof node.value === 'string' && !node.value.isWellFormed()) fail('Invalid Unicode scalar value');
      },
    });
  }
}

function guardSyntax(language, bytes, moduleKind) {
  if (language === 'Yaml') guardYaml(decode(bytes));
  if (language === 'JavaScript') command(process.execPath, ['--check', `--input-type=${moduleKind}`], { input: bytes });
  if (language === 'TypeScript') {
    const js = stripTypeScriptTypes(decode(bytes));
    command(process.execPath, ['--check', `--input-type=${moduleKind}`], { input: js });
  }
  if (language === 'Python') command('python3', ['-I', '-B', '-c', 'import ast, sys; ast.parse(sys.stdin.buffer.read())'], { input: bytes });
  if (language === 'Bash') command('bash', ['--noprofile', '--norc', '-n'], { input: bytes, rejectStderr: true });
}

function envComments(bytes) {
  const result = [];
  for (const row of lines(bytes)) {
    const raw = row.text.replace(/\r$/u, '');
    const assignment = raw.match(/^\s*(?:export[ \t]+)?[A-Za-z_][A-Za-z_0-9]*[ \t]*=[ \t]*/u);
    if (raw.trim() === '') continue;
    const index = raw.search(/\S/u);
    if (!assignment && raw[index] !== '#') throw new Error('Unsupported env assignment');
    let i = assignment?.[0].length ?? index;
    if (assignment && /[ \t]$/u.test(assignment[0]) && raw[i] && raw[i] !== '#') {
      throw new Error('Unsupported whitespace before env value');
    }
    if (assignment && (raw[i] === '"' || raw[i] === "'")) {
      const quote = raw[i++];
      while (i < raw.length && raw[i] !== quote) {
        if (quote === '"') {
          if (raw[i] === '`' || raw.startsWith('$(', i)) throw new Error('Unsupported executable substitution in env value');
          if (raw[i] === '\\') i++;
        }
        i++;
      }
      if (raw[i++] !== quote) throw new Error('Unclosed env quote (multiline values are not supported)');
      if (raw.slice(i).trim() && !/^[ \t]+#/u.test(raw.slice(i))) throw new Error('Unsupported text after env quote');
      i = raw.indexOf('#', i);
    } else if (assignment) {
      const value = raw.slice(i);
      const marker = value.search(/(?<![^ \t])#/u);
      const spaceBeforeValue = /[ \t]$/u.test(assignment[0]);
      i = marker === 0 && !spaceBeforeValue ? -1 : marker < 0 ? -1 : i + marker;
      const bare = raw.slice(assignment[0].length, i < 0 ? raw.length : i);
      if (/['"\\`;|&<>()]/u.test(bare) || /\S+[ \t]+\S/u.test(bare)) throw new Error('Unsupported unquoted env value');
    }
    if (i >= 0) result.push({ start: row.start + Buffer.byteLength(raw.slice(0, i)), end: row.start + Buffer.byteLength(raw), text: raw.slice(i) });
  }
  return result;
}

function gitignoreComments(bytes) {
  return lines(bytes).flatMap(row => row.text.startsWith('#') ? [{
    start: row.start, end: row.end - Number(row.text.endsWith('\r')), text: row.text.replace(/\r$/u, ''),
  }] : []);
}

function parseSource(bin, language, bytes, moduleKind, checkWholeTree) {
  if (language === 'Env') return envComments(bytes);
  if (language === 'Gitignore') return gitignoreComments(bytes);
  if (language === 'TypeScript') completeTree(bin, language, bytes);
  guardSyntax(language, bytes, moduleKind);
  const invalid = ast(bin, language, 'ERROR', bytes);
  if (invalid.length) throw new Error(`${language} parse error at byte ${invalid[0].start}`);
  if (checkWholeTree && language !== 'TypeScript') completeTree(bin, language, bytes);
  const kinds = language === 'JavaScript' || language === 'TypeScript' ? 'comment, hash_bang_line' : 'comment';
  return ast(bin, language, kinds, bytes);
}

const bashInterpreter = /^(?:(?:\/usr\/bin\/env|command|exec)\s+)?(?:(?:\/usr)?\/bin\/)?(node|python(?:3(?:\.\d+)?)?|bash|sh|dash|zsh|perl|ruby|php|lua|awk|cat)(?=\s|$)/u;

function bashFragments(bin, source, { workflow }) {
  const redirects = ast(bin, 'Bash', 'heredoc_redirect', source);
  const commands = ast(bin, 'Bash', 'command', source);
  for (const { text } of commands) {
    const body = text.replace(/^(?:(?:command|exec|sudo|env|\/usr\/bin\/env)\s+)*/u, '');
    const name = body.match(/^(\S+)/u)?.[1];
    const interpreter = body.match(bashInterpreter)?.[1];
    if ((workflow && (!name || !/^[\w./-]+$/u.test(name) || /^(?:eval|source|\.)$/u.test(name) ||
          (name === 'trap' && !/^trap\s+(?:[\w]+|-)\s+[\w ]+$/u.test(body)))) ||
        (interpreter && (/\s(?:-[a-zA-Z]*[ecE]|--(?:eval|print|command)(?:[=\s]|$))/u.test(body) || body.includes('<<<')))) {
      throw new Error('Unsupported dynamic or inline interpreter command in Bash source');
    }
  }
  if (!redirects.length) return [];
  const bodies = ast(bin, 'Bash', 'heredoc_body', source);
  const owners = ast(bin, 'Bash', 'redirected_statement', source);
  const sequence = new Map();
  return redirects.flatMap(redirect => {
    const owner = owners.filter(node => node.start < redirect.start && node.end >= redirect.end).at(-1);
    const header = owner && decode(source.subarray(owner.start, redirect.start));
    const kind = header?.match(bashInterpreter)?.[1];
    const marker = redirect.text.match(/^<<[ \t]*'([A-Z][A-Z0-9_]*)'[ \t]*(?:\r?\n)/u)?.[1];
    if (!kind || !marker) throw new Error('Unsupported heredoc: expected a static interpreter and single-quoted delimiter');
    if (kind === 'cat' && header.trim() === 'cat') return [];
    const language = kind === 'node' && /^node[ \t]+--input-type=module(?:[ \t]|$)/u.test(header) ? 'JavaScript' :
      /^python(?:3(?:\.\d+)?)?$/u.test(kind) && /^python(?:3(?:\.\d+)?)?[ \t]+-(?:[ \t]|$)/u.test(header) ? 'Python' : null;
    if (!language) throw new Error(`Unsupported executable heredoc for ${kind}`);
    const matches = bodies.filter(node => node.start > redirect.start && node.end <= redirect.end);
    const body = matches[0];
    if (matches.length !== 1 || decode(source.subarray(body.end, redirect.end)) !== marker) {
      throw new Error(`Cannot map heredoc ${marker} to original source`);
    }
    const key = `${kind}:${marker}`;
    const part = `${key}:${(sequence.get(key) ?? 0) + 1}`;
    sequence.set(key, (sequence.get(key) ?? 0) + 1);
    return [{ language, part, bytes: source.subarray(body.start, body.end), map: offset => offset + body.start }];
  });
}

function readPair(node, bytes) {
  const key = node.text.match(/^(?:([\w.-]+)|'([\w.-]+)'|"([\w.-]+)")[ \t]*:/u);
  if (!key) throw new Error('Unsupported workflow mapping key');
  let start = node.start + Buffer.byteLength(key[0]);
  while (start < node.end && (bytes[start] === 32 || bytes[start] === 9)) start++;
  return { ...node, key: key[1] ?? key[2] ?? key[3], value: decode(bytes.subarray(start, node.end)), valueStart: start };
}

function literalRun(pair, bytes) {
  const rows = lines(bytes.subarray(pair.valueStart, pair.end));
  const header = rows[0]?.text;
  if (!header) throw new Error('Missing workflow run value');
  if (/^\|[+-]?[ \t]*(?:#[^\r]*)?\r?$/u.test(header)) {
    const body = rows.slice(1);
    const indent = body.find(row => row.text.trim())?.text.match(/^ */u)[0].length;
    if (!indent) throw new Error('Empty or unmappable workflow block run');
    let cursor = 0;
    const chunks = [];
    const mapRows = [];
    for (const row of body) {
      const removed = row.text.trim() ? indent : Math.min(indent, row.text.match(/^ */u)[0].length);
      if (!row.text.startsWith(' '.repeat(removed))) throw new Error('Ambiguous workflow block indentation');
      const origin = pair.valueStart + row.start + removed;
      const data = bytes.subarray(origin, pair.valueStart + row.next);
      mapRows.push({ cursor, origin, size: data.length });
      chunks.push(data);
      cursor += data.length;
    }
    return { bytes: Buffer.concat(chunks), map: (offset, end) => {
      const row = mapRows.findLast(row => row.cursor < offset || (!end && row.cursor === offset));
      if (!row || offset > row.cursor + row.size) throw new Error('Unmappable workflow token');
      return row.origin + offset - row.cursor;
    } };
  }
  if (rows.length !== 1 || /^[\s>|\[{&*!]/u.test(header)) throw new Error('Unsupported workflow run scalar');
  const trim = header.trimEnd();
  const quoted = trim.startsWith('"') || trim.startsWith("'");
  const body = quoted ? trim.slice(1, -1) : trim;
  if (quoted && (trim.at(-1) !== trim[0] || body.includes(trim[0]) || (trim[0] === '"' && body.includes('\\')))) {
    throw new Error('Unsupported escape or quote in workflow run scalar; use a literal block');
  }
  return { bytes: Buffer.from(body), map: offset => pair.valueStart + Number(quoted) + offset };
}

function workflowFragments(bin, bytes) {
  const nodes = ast(bin, 'Yaml', 'block_mapping_pair', bytes).map(node => readPair(node, bytes));
  const items = ast(bin, 'Yaml', 'block_sequence_item', bytes);
  if (ast(bin, 'Yaml', 'alias, anchor, tag, flow_pair', bytes).length) {
    throw new Error('Unsupported workflow structure: use block mappings without aliases, anchors or tags');
  }
  if (nodes.some(node => node.key === 'script' ||
      (node.key === 'uses' && /(?:^|\/)github-script@/iu.test(node.value)) ||
      (node.key === 'shell' && !/^(?:bash|sh|'bash'|'sh'|"bash"|"sh")$/u.test(node.value.trim())))) {
    throw new Error('Unsupported executable workflow field or shell');
  }
  const children = parent => nodes.filter(node => node.start > parent.start && node.end <= parent.end &&
    !nodes.some(other => other.start > parent.start && other.start < node.start && other.end >= node.end));
  const jobs = nodes.filter(node => node.start === 0 || bytes[node.start - 1] === 10).filter(node => node.key === 'jobs');
  if (jobs.length !== 1) throw new Error('Expected a single workflow jobs mapping');
  const runs = nodes.filter(node => node.key === 'run');
  const seen = new Set();
  const fragments = [];
  for (const job of children(jobs[0])) {
    const steps = children(job).filter(node => node.key === 'steps');
    if (steps.length > 1) throw new Error(`Duplicate workflow steps for ${job.key}`);
    if (!steps.length) continue;
    const value = steps[0];
    const stepItems = items.filter(node => node.start > value.start && node.end <= value.end &&
      !items.some(other => other.start > value.start && other.start < node.start && other.end >= node.end));
    if (!stepItems.length && value.value.trim() !== '[]') throw new Error('Expected a block sequence of workflow steps');
    let unnamed = 0;
    for (const item of stepItems) {
      const fields = children(item);
      const script = fields.filter(field => field.key === 'run');
      if (!script.length) continue;
      if (script.length !== 1) throw new Error('Duplicate run in workflow step');
      const id = fields.find(field => field.key === 'id')?.value.trim();
      const name = fields.find(field => field.key === 'name')?.value.trim();
      const part = `jobs/${job.key}/${id ? `id:${id}` : name ? `name:${name}` : `unnamed:${++unnamed}`}`;
      if (seen.has(part)) throw new Error('Duplicate workflow step identity; give each run a unique id');
      seen.add(part);
      const block = literalRun(script[0], bytes);
      if (decode(block.bytes).includes('${{')) throw new Error('Use env for workflow expressions instead of interpolating executable run text');
      fragments.push({ ...block, language: 'Bash', part });
    }
  }
  const defaults = nodes.filter(node => node.key === 'defaults').flatMap(children);
  if (runs.length !== fragments.length + defaults.filter(node => node.key === 'run').length) {
    throw new Error('Unmapped executable workflow run');
  }
  return fragments;
}

function physicalLines(bytes, rows, tokens) {
  const occupied = new Map();
  for (const token of tokens) {
    for (let n = token.start.line; n <= Math.min(rows.length, token.end.line); n++) {
      const row = rows[n - 1];
      const start = Math.max(token.byteStart, row.start);
      const end = Math.min(token.byteEnd, row.end);
      if (end > start || (row.start === row.end && token.byteStart < start && token.byteEnd > end)) {
        (occupied.get(n) ?? occupied.set(n, []).get(n)).push({ start, end, token });
      }
    }
  }
  const all = [];
  const ordinary = [];
  for (const [n, slices] of occupied) {
    const row = rows[n - 1];
    let cursor = row.start;
    let rest = '';
    for (const { start, end } of slices.sort((a, b) => a.start - b.start)) {
      if (cursor < start) rest += decode(bytes.subarray(cursor, start));
      cursor = Math.max(cursor, end);
    }
    rest += decode(bytes.subarray(cursor, row.end));
    if (rest.trim()) continue;
    all.push(n);
    if (slices.every(({ token }) => token.kind === 'comment')) ordinary.push(n);
  }
  return { commentOnlyLines: all, ordinaryCommentOnlyLines: ordinary };
}

function bindDirectives(rows, tokens, commentOnlyLines) {
  const commentOnly = new Set(commentOnlyLines);
  const codeBefore = [0];
  for (const [index, row] of rows.entries()) {
    codeBefore.push(codeBefore.at(-1) + Number(Boolean(row.text.trim()) && !commentOnly.has(index + 1)));
  }
  for (const token of tokens) {
    if (token.kind !== 'directive') continue;
    const row = token.start.line - 1;
    const adjacent = [codeBefore[row], token.start.column];
    if (/^(?:\/\/|\/\*+)\s*@ts-(?:ignore|expect-error)\b/u.test(token.text)) {
      adjacent.push(rows[row]?.text, rows[token.end.line]?.text);
    } else if (!/^(?:\/\/|\/\*+)\s*@ts-(?:no)?check\b/u.test(token.text)) {
      adjacent.push(rows[row - 1]?.text, rows[row]?.text, rows[token.end.line]?.text);
    }
    token.directiveAnchor = createHash('sha256').update(JSON.stringify(adjacent)).digest('hex');
  }
}

export function inspect(bin, path, language, bytes) {
  const text = decode(bytes);
  if (text.includes('\0')) throw new Error('NUL in text source');
  const rows = lines(bytes);
  if (language === 'Json') JSON.parse(text);
  if (language === 'NodeVersion' && !/^\d+\r?\n?$/u.test(text)) throw new Error('Expected a Node.js major version');
  const workflow = language === 'Yaml' && path.startsWith('.github/workflows/');
  const tokens = [];
  function visit(lang, source, parts, toFile) {
    const moduleKind = !parts.length && /\.[c][jt]s$/u.test(path) ? 'commonjs' : 'module';
    const nodes = parseSource(bin, lang, source, moduleKind, lang === 'Yaml' || parts.length > 0);
    for (const node of nodes) {
      const start = toFile(node.start, false);
      const end = toFile(node.end, true);
      const raw = bytes.subarray(start, end);
      tokens.push({ language: lang, fragment: parts, ...span(bytes, rows, start, end), kind: location(node.text, node.start),
        text: node.text, raw: decode(raw), hash: createHash('sha256').update(raw).digest('hex') });
    }
    const children = lang === 'Bash' ? bashFragments(bin, source, { workflow }) :
      workflow && lang === 'Yaml' ? workflowFragments(bin, source) : [];
    for (const child of children) {
      visit(child.language, child.bytes, [...parts, child.part], (offset, end) => toFile(child.map(offset, end), end));
    }
  }
  if (!['Json', 'NodeVersion', 'Excluded'].includes(language)) visit(language, bytes, [], offset => offset);
  tokens.sort((a, b) => a.byteStart - b.byteStart);
  const counts = new Map();
  for (const token of tokens) {
    const key = JSON.stringify([token.language, token.fragment, token.hash]);
    token.occurrence = (counts.get(key) ?? 0) + 1;
    counts.set(key, token.occurrence);
  }
  const countsByLine = physicalLines(bytes, rows, tokens);
  bindDirectives(rows, tokens, countsByLine.commentOnlyLines);
  return { path, language, physicalLines: rows.length, tokens, ...countsByLine };
}

export function formatFor(path) {
  const name = path.split('/').at(-1);
  if (name === '.gitignore') return 'Gitignore';
  if (name === '.node-version') return 'NodeVersion';
  if (path === 'config/pi/i-have-adhd-always') return 'Json';
  if (name === '.env' || name === 'env.example' || /^\.env\.[\w.-]+$/u.test(name)) return 'Env';
  if (/^(?:LICENSE|NOTICE)(?:\.txt)?$/u.test(name) || /\.md$/iu.test(name)) return 'Excluded';
  const formats = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
    py: 'Python', sh: 'Bash', yml: 'Yaml', yaml: 'Yaml', json: 'Json' };
  const ext = name.match(/\.([a-z]+)$/u)?.[1];
  if (!ext || !Object.hasOwn(formats, ext)) throw new Error(`Unsupported source format: ${path}`);
  return formats[ext];
}
