import type { ProofKind } from '../types'

// A simple command and the operator that follows it ('' after the last).
export type Segment = { words: string[]; sep: string }
// complex: substitutions, backticks, subshells or heredocs whose effect a parse cannot see.
export type Parsed = { segments: Segment[]; complex: boolean; heredocs: string[] }

const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2(?=\s|\)|$)/g

// Splits a command into simple commands, honouring quotes and comments: operators
// inside quotes, $(...), backticks or a # comment are text, never separators.
export function parse(command: string): Parsed {
  const heredocs: string[] = []
  let complex = false
  // Heredoc bodies are data; keep them aside and drop them from what is split.
  const text = command.replace(HEREDOC, (_m, _q, tag: string, body: string) => {
    heredocs.push(body)
    complex = true
    return `<<${tag}`
  })

  const segments: Segment[] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endSegment = (sep: string) => {
    endWord()
    if (words.length > 0) segments.push({ words, sep })
    else if (segments.length > 0 && sep !== '') segments[segments.length - 1]!.sep = sep
    words = []
  }

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!
    const two = text.slice(i, i + 2)
    if (c === '\\' && i + 1 < text.length) {
      if (text[i + 1] !== '\n') word += text[i + 1]
      hasWord = hasWord || text[i + 1] !== '\n'
      i += 1
    } else if (c === '#' && !hasWord) {
      // A comment runs to the end of the line.
      const end = text.indexOf('\n', i)
      i = (end === -1 ? text.length : end) - 1
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end === -1 ? text.length : end
      word += text.slice(i + 1, stop)
      hasWord = true
      i = stop
    } else if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          word += text[j + 1]
          j += 2
          continue
        }
        if (text.slice(j, j + 2) === '$(' || text[j] === '`') complex = true
        word += text[j]
        j += 1
      }
      hasWord = true
      i = j
    } else if (two === '$(') {
      complex = true
      let depth = 0
      let j = i + 1
      for (; j < text.length; j += 1) {
        if (text[j] === '(') depth += 1
        else if (text[j] === ')' && (depth -= 1) === 0) break
      }
      word += text.slice(i, j + 1)
      hasWord = true
      i = j
    } else if (c === '`') {
      complex = true
      const end = text.indexOf('`', i + 1)
      const stop = end === -1 ? text.length : end
      word += text.slice(i, stop + 1)
      hasWord = true
      i = stop
    } else if (two === '&&' || two === '||') {
      endSegment(two)
      i += 1
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      // `2>&1` and `&>` are redirections, not separators.
      if (c === '&' && (text[i - 1] === '>' || text[i + 1] === '>')) {
        word += c
        hasWord = true
      } else {
        endSegment(c === '\n' ? ';' : c)
      }
    } else if ((c === '(' || c === ')' || c === '{' || c === '}') && !hasWord) {
      complex = true
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else {
      word += c
      hasWord = true
    }
  }
  endSegment('')
  // A trailing `;` or newline ends the command; nothing follows it.
  const last = segments[segments.length - 1]
  if (last !== undefined && last.sep === ';') last.sep = ''
  // `bash -c '...'` runs a command of its own: look inside it, in place.
  const flat: Segment[] = []
  for (const seg of segments) {
    const inner = shellInner(seg.words)
    if (inner === null) {
      flat.push(seg)
      continue
    }
    const p = parse(inner)
    heredocs.push(...p.heredocs)
    if (p.complex || p.segments.length > 1) complex = true
    p.segments.forEach((s, i) => flat.push(i === p.segments.length - 1 ? { ...s, sep: seg.sep } : s))
  }
  return { segments: flat, complex, heredocs }
}

// The commands inside $(...) and backticks: they run too.
export function substitutions(command: string): string[] {
  const found: string[] = []
  for (let i = 0; i < command.length; i += 1) {
    if (command.slice(i, i + 2) === '$(') {
      let depth = 0
      let j = i + 1
      for (; j < command.length; j += 1) {
        if (command[j] === '(') depth += 1
        else if (command[j] === ')' && (depth -= 1) === 0) break
      }
      found.push(command.slice(i + 2, j))
      i = j
    } else if (command[i] === '`') {
      const end = command.indexOf('`', i + 1)
      if (end === -1) break
      found.push(command.slice(i + 1, end))
      i = end
    }
  }
  return found
}

function shellInner(words: string[]): string | null {
  const argv = unwrap(words)
  if (!['bash', 'sh', 'zsh'].includes(base(argv[0] ?? ''))) return null
  const at = argv.findIndex((w, i) => i > 0 && /^-[a-z]*c$/.test(w))
  return at === -1 ? null : argv[at + 1] ?? null
}

// Redirections and their targets say where output goes, not what runs.
export function stripRedirects(words: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!
    if (/^(\d*|&)(>>?|<)$/.test(w) || /^\d*>&$/.test(w)) {
      i += 1
      continue
    }
    if (/^(\d*|&)(>>?|<)./.test(w) || /^\d*>&\d+$/.test(w)) continue
    out.push(w)
  }
  return out
}

// Drops what runs a tool without being it: env assignments, npx and its flags, time, python -m.
export function unwrap(argv: string[]): string[] {
  let rest = [...argv]
  for (;;) {
    const first = rest[0]
    if (first === undefined) return rest
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) rest = rest.slice(1)
    else if (WRAPPERS[base(first)] !== undefined) {
      const takesValue = WRAPPERS[base(first)]!
      rest = rest.slice(1)
      while (rest[0]?.startsWith('-')) rest = rest.slice(takesValue.includes(rest[0]) ? 2 : 1)
    } else if (['pnpm', 'yarn'].includes(first) && ['exec', 'dlx'].includes(rest[1] ?? '')) rest = rest.slice(2)
    else if (['uv', 'poetry', 'pipenv'].includes(first) && rest[1] === 'run') rest = rest.slice(2)
    else if (/^python[\d.]*$/.test(base(first)) && rest[1] === '-m') rest = rest.slice(2)
    else return rest
  }
}

const base = (word: string) => word.replace(/^.*\//, '')

// Commands that run another, with the flags of theirs that take a value.
const WRAPPERS: Record<string, string[]> = {
  npx: ['-p', '--package', '-c', '--call'], bunx: ['-p', '--package'], time: ['-f', '-o'], command: [],
  exec: ['-a'], nice: ['-n'], env: ['-u', '-C', '-S'], sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-U'],
}

export type Check = {
  kind: ProofKind
  scope: 'project' | 'scoped' | 'filtered'
  files: string[]
  label: string
  tool: string
  // Cargo only: the run named --workspace / --all.
  wholeWorkspace: boolean
}

// Flags whose next word is a value.
const VALUE = new Set([
  '-c', '--config', '--config-file', '--rootDir', '--reporter', '--outputFile', '--junitxml', '--cov',
  '--format', '-f', '--output', '-configuration', '-destination', '-sdk', '-scheme', '-workspace',
  '--target', '--features', '--profile', '-j', '--jobs', '--maxWorkers', '-n', '--numprocesses', '--timeout',
  '--testTimeout', '--env', '--environment', '--color', '--max-warnings', '--ext', '--cache-location',
  '--pretty', '--maxWorkers', '--reporters', '--log-level', '--seed',
])
// Flags that pick some tests by name or by change: the run proves nothing about the rest.
const FILTER = new Set([
  '-k', '-t', '-m', '--testNamePattern', '--testPathPattern', '--grep', '-g', '--filter', '--tests',
  '--run', '-run', '-only-testing', '-skip-testing', '--shard', '--test', '--bin', '--example', '--bench',
  '--exclude', '--ignore', '--ignore-glob', '--deselect', '--testPathIgnorePatterns', '--skip', '-skip',
])
const FILTER_BARE = new Set([
  '--changed', '--onlyChanged', '-o', '--lf', '--last-failed', '--sf', '--stepwise', '--lib', '--doc',
  '--bins', '--examples', '--findRelatedTests', '--only-failures', '--related',
])
// Flags that narrow to one package or directory of a monorepo.
const PACKAGE = new Set(['--workspace', '--prefix', '-C', '-p', '--package', '--manifest-path', '--project', '--dir', '--cwd'])
// Flags that make a runner list, describe or maybe skip instead of check.
const NOT_A_RUN = new Set([
  '--listTests', '--list-tests', '--collect-only', '--co', '--showConfig', '--version', '--help', '-h',
  '--list', '--dry-run', '--no-run', '--watch', '--watchAll', '--init', '--print-config', '--fix-dry-run',
  '--if-present', '--noCheck', '--listFilesOnly', '-list',
])

const PROJECT_SCRIPTS: Record<string, ProofKind> = {
  test: 'tests', tests: 'tests', lint: 'lint', typecheck: 'typecheck', 'type-check': 'typecheck', tsc: 'typecheck',
  'check-types': 'typecheck', types: 'typecheck', build: 'build',
}

function scriptKind(script: string): ProofKind | null {
  if (/^tests?(:|$)|^(unit|e2e|spec|jest|vitest)(:|$)/.test(script)) return 'tests'
  if (/type-?check|^tsc(:|$)|^types(:|$)|^check-types(:|$)/.test(script)) return 'typecheck'
  if (/^lint(:|$)/.test(script)) return 'lint'
  if (/^build(:|$)/.test(script)) return 'build'
  return null
}

// What the arguments after the runner say about the run's reach.
function reach(args: string[], tool: string): { scope: Check['scope']; files: string[]; whole: boolean } | null {
  let scope: Check['scope'] = 'project'
  let whole = false
  const files: string[] = []
  const narrow = (to: Check['scope']) => {
    if (scope !== 'filtered') scope = to
  }
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i]!
    const eq = word.indexOf('=')
    const flag = eq === -1 ? word : word.slice(0, eq)
    const inline = eq === -1 ? undefined : word.slice(eq + 1)
    if (word === '--') continue
    if (flag === '-w') {
      // -w names a workspace for npm, sets workers for jest, and watches everywhere else.
      if (['npm', 'yarn', 'pnpm', 'bun'].includes(tool)) narrow('scoped')
      else if (tool !== 'jest') return null
      if (inline === undefined) i += 1
      continue
    }
    if (NOT_A_RUN.has(flag)) return null
    if (word.startsWith('-')) {
      if (tool === 'cargo' && (flag === '--workspace' || flag === '--all')) {
        whole = true
      } else if (FILTER.has(flag)) {
        scope = 'filtered'
        if (inline === undefined) i += 1
      } else if (FILTER_BARE.has(flag) || /^-(only|skip)-testing:/.test(word)) {
        scope = 'filtered'
      } else if (/^-[ktm]./.test(word) && ['pytest', 'py.test', 'jest', 'vitest'].includes(tool)) {
        // -kfoo, -tname: a filter with its value attached.
        scope = 'filtered'
      } else if (PACKAGE.has(flag)) {
        const value = inline ?? args[i + 1] ?? ''
        if (inline === undefined) i += 1
        // `tsc -p tsconfig.json` / `-p .` at the root is still the whole project.
        if (!(tool === 'tsc' && /^(\.\/?)?(tsconfig\.json)?$/.test(value))) narrow('scoped')
      } else if (VALUE.has(flag) && inline === undefined) {
        i += 1
      }
      continue
    }
    if (word === '.' || word === './' || word === './...' || word === '...') continue
    // A flag's boolean value (`--pretty false`), not a path.
    if (word === 'true' || word === 'false') continue
    // A positional names files, a directory, a package or a name filter: never the whole project.
    files.push(word.replace(/^\.\//, '').replace(/\/$/, ''))
    narrow('scoped')
  }
  return { scope, files, whole }
}

type Hit = { kind: ProofKind; args: string[]; tool: string; forceScoped?: boolean }

function classify(argv: string[]): Hit | null {
  const [a = '', b = '', c = ''] = argv
  const tool = base(a)
  if (['npm', 'yarn', 'pnpm', 'bun'].includes(tool)) {
    if (tool === 'bun' && b === 'test') return { kind: 'tests', args: argv.slice(2), tool: 'bun-test' }
    // Workspace flags may come before the script.
    let rest = argv.slice(1)
    let scoped = false
    while (rest[0]?.startsWith('-')) {
      const word = rest[0]
      const flag = word.includes('=') ? word.slice(0, word.indexOf('=')) : word
      if (NOT_A_RUN.has(flag)) return null
      if (PACKAGE.has(flag) || ['--filter', '-F', '-w'].includes(flag)) {
        scoped = true
        rest = rest.slice(word.includes('=') ? 1 : 2)
      } else rest = rest.slice(1)
    }
    const isRun = rest[0] === 'run' || rest[0] === 'run-script'
    const script = isRun ? rest[1] ?? '' : rest[0] ?? ''
    const kind = scriptKind(script)
    if (kind === null) return null
    const args = rest.slice(isRun ? 2 : 1)
    return { kind, args, tool, forceScoped: scoped || PROJECT_SCRIPTS[script] === undefined }
  }
  if (['jest', 'vitest', 'mocha', 'ava', 'pytest', 'py.test'].includes(tool)) {
    if (tool === 'vitest' && b === 'watch') return null
    const args = argv.slice(1)
    if (tool === 'vitest' && b === 'run') return { kind: 'tests', args: args.slice(1), tool }
    if (tool === 'vitest' && b === 'related') return { kind: 'tests', args: ['--related', ...args.slice(1)], tool }
    return { kind: 'tests', args, tool }
  }
  if (tool === 'nextest' && b === 'run') return { kind: 'tests', args: argv.slice(2), tool: 'cargo' }
  if (tool === 'playwright' && b === 'test') return { kind: 'tests', args: argv.slice(2), tool }
  if (['tsc', 'vue-tsc', 'mypy', 'pyright'].includes(tool)) return { kind: 'typecheck', args: argv.slice(1), tool: tool === 'vue-tsc' ? 'tsc' : tool }
  if (['eslint', 'flake8', 'pylint', 'swiftlint', 'golangci-lint', 'rubocop', 'ktlint'].includes(tool)) {
    if (tool === 'golangci-lint' && b === 'run') return { kind: 'lint', args: argv.slice(2), tool }
    return { kind: 'lint', args: argv.slice(1), tool }
  }
  if (tool === 'ruff' && (b === 'check' || b === '')) return { kind: 'lint', args: argv.slice(2), tool }
  if (tool === 'biome' && ['check', 'lint', 'ci'].includes(b)) return { kind: 'lint', args: argv.slice(2), tool }
  if (tool === 'go') {
    const kind = ({ test: 'tests', vet: 'lint', build: 'build' } as const)[b as 'test' | 'vet' | 'build']
    if (kind === undefined) return null
    const args = argv.slice(2)
    // -c compiles the test binary, -list lists tests: neither runs them.
    if (args.some(w => w === '-c' || w === '-list' || w.startsWith('-list='))) return null
    // Bare `go test` checks only the package in this directory; `./...` is everything under it.
    return { kind, args, tool, forceScoped: !(args.includes('./...') || args.includes('...')) }
  }
  if (tool === 'cargo') {
    const kind = ({ test: 'tests', nextest: 'tests', check: 'typecheck', clippy: 'lint', build: 'build' } as const)[b as 'test']
    if (kind === undefined) return null
    return { kind, args: argv.slice(b === 'nextest' && c === 'run' ? 3 : 2), tool }
  }
  if (tool === 'swift' && (b === 'test' || b === 'build')) return { kind: b === 'test' ? 'tests' : 'build', args: argv.slice(2), tool }
  if (tool === 'xcodebuild') {
    const kind = argv.includes('test') ? 'tests' : argv.includes('build') ? 'build' : null
    if (kind === null || argv.includes('-dry-run') || argv.includes('-n')) return null
    // Only the filters matter here; the rest are settings.
    return { kind, args: argv.slice(1).filter(w => /^-(only|skip)-testing/.test(w)), tool }
  }
  if (/^(gradlew|gradle)$/.test(tool)) {
    if (argv.some(w => ['--dry-run', '-m', '--help', '--status'].includes(w))) return null
    const tasks = argv.slice(1).filter(w => !w.startsWith('-'))
    const tests = tasks.filter(t => /(^|:)(test|check|connectedAndroidTest)\w*$/i.test(t))
    const builds = tasks.filter(t => /(^|:)(build|assemble)\w*$/i.test(t))
    const picked = tests.length > 0 ? tests : builds
    if (picked.length === 0) return null
    return {
      kind: tests.length > 0 ? 'tests' : 'build',
      args: argv.includes('--tests') ? ['--tests', 'x'] : [],
      tool,
      forceScoped: picked.some(t => t.includes(':')),
    }
  }
  if (tool === 'make') {
    if (argv.some(w => ['-n', '--dry-run', '--just-print', '-q', '--question'].includes(w))) return null
    const rest = argv.slice(1)
    let elsewhere = false
    const targets: string[] = []
    for (let i = 0; i < rest.length; i += 1) {
      const w = rest[i]!
      if (w === '-C' || w === '--directory') {
        elsewhere = true
        i += 1
      } else if (/^-C.|^--directory=/.test(w)) elsewhere = true
      else if (w === '-f' || w === '-j' || w === '--file' || w === '-I') i += 1
      else if (!w.startsWith('-') && !w.includes('=')) targets.push(w)
    }
    const target = targets[0]
    if (target === 'test' || target === 'check') return { kind: 'tests', args: [], tool, forceScoped: elsewhere }
    if (target === 'lint') return { kind: 'lint', args: [], tool, forceScoped: elsewhere }
  }
  return null
}

// The verification a simple command runs, if any.
export function checkOf(words: string[]): Check | null {
  const argv = unwrap(stripRedirects(words))
  const hit = classify(argv)
  if (hit === null) return null
  const r = reach(hit.args, hit.tool)
  if (r === null) return null
  const scope = r.scope === 'project' && hit.forceScoped === true ? 'scoped' : r.scope
  return {
    kind: hit.kind, scope, files: [...new Set(r.files)].sort(), label: argv.join(' ').slice(0, 120),
    tool: hit.tool, wholeWorkspace: r.whole,
  }
}

// Commands that change nothing a check depends on.
const HARMLESS = /^(cd|pushd|popd|echo|printf|true|ls|pwd|which|date|sleep)$/
export function isHarmless(words: string[]): boolean {
  if (words.some(w => /[<>]/.test(w) || w.includes('$(') || w.includes('`'))) return false
  const argv = unwrap(words)
  const tool = base(argv[0] ?? '')
  if (HARMLESS.test(tool)) return true
  return tool === 'git' && ['add', 'status', 'diff', 'log', 'show', 'rev-parse', 'branch'].includes(argv[1] ?? '')
}

// Commands that cannot fail, so a failed chain was not their doing.
export function isInfallible(words: string[]): boolean {
  if (words.some(w => /[<>]/.test(w) || w.includes('$(') || w.includes('`'))) return false
  return /^(echo|printf|true|:)$/.test(base(unwrap(words)[0] ?? ''))
}

export type Commit = {
  // Directories git -C moves through, in order.
  dirs: string[]
  messages: string[]
  file: string | null
  // A message to read from history: `--amend` keeping it, or -C REV.
  reuse: string | null
  // The message cannot be seen (a variable, an editor) before the commit runs.
  unknown: boolean
  // --git-dir / --work-tree / GIT_DIR: the target repo is not the directory.
  retargeted: boolean
  // -a / --all: tracked changes are staged by the commit itself.
  all: boolean
  // Pathspecs, --only or --include: only part of the index is committed.
  partial: boolean
}

// Shell expansions git would see substituted: the text is not known in advance.
const EXPANDS = /\$[({A-Za-z_0-9?#@*!$-]|`/

// A `git commit` and where its message comes from; null if the command is not one.
export function commitOf(words: string[], heredocs: string[]): Commit | null {
  const retargetedByEnv = words.some(w => /^GIT_(DIR|WORK_TREE|INDEX_FILE)=/.test(w))
  const argv = unwrap(stripRedirects(words))
  if (base(argv[0] ?? '') !== 'git') return null
  let i = 1
  const dirs: string[] = []
  let retargeted = retargetedByEnv
  while (i < argv.length && argv[i]!.startsWith('-')) {
    const flag = argv[i]!
    if (flag === '-C') {
      dirs.push(argv[i + 1] ?? '.')
      i += 2
    } else if (flag === '-c' || flag === '--namespace') {
      i += 2
    } else if (flag === '--git-dir' || flag === '--work-tree') {
      retargeted = true
      i += 2
    } else {
      if (flag.startsWith('--git-dir=') || flag.startsWith('--work-tree=')) retargeted = true
      i += 1
    }
  }
  if (argv[i] !== 'commit') return null
  const c: Commit = { dirs, messages: [], file: null, reuse: null, unknown: false, retargeted, all: false, partial: false }
  let amend = false
  let edits: boolean | null = null
  const args = argv.slice(i + 1)
  const take = (value: string | undefined) => {
    if (value === undefined) return
    if (/\$\(\s*cat\s*<</.test(value)) c.messages.push(...heredocs)
    else if (EXPANDS.test(value)) c.unknown = true
    else c.messages.push(value)
  }
  for (let j = 0; j < args.length; j += 1) {
    const w = args[j]!
    if (w === '--') {
      if (j + 1 < args.length) c.partial = true
      break
    }
    if (w === '-m' || w === '--message') take(args[(j += 1)])
    else if (w.startsWith('--message=')) take(w.slice(10))
    else if (w === '-F' || w === '--file') c.file = args[(j += 1)] ?? null
    else if (w.startsWith('--file=')) c.file = w.slice(7)
    else if (w === '-C' || w === '--reuse-message') c.reuse = args[(j += 1)] ?? 'HEAD'
    else if (w.startsWith('--reuse-message=')) c.reuse = w.slice(16)
    else if (w === '-c' || w === '--reedit-message' || w.startsWith('--reedit-message=')) {
      // Opens an editor on the reused message: the final text is unknown.
      c.unknown = true
      if (!w.includes('=')) j += 1
    } else if (w === '--amend') amend = true
    else if (w === '--no-edit') edits = false
    else if (w === '--edit' || w === '-e') edits = true
    else if (w === '--all') c.all = true
    else if (w === '--only' || w === '-o' || w === '--include' || w === '-i' || w === '--interactive' || w === '-p' || w === '--patch') c.partial = true
    else if (w.startsWith('--')) continue
    else if (w.startsWith('-')) {
      // Short flags, bundled or with an attached value: -am "msg", -m"msg", -Fmsg.txt, -aC HEAD.
      for (let k = 1; k < w.length; k += 1) {
        const f = w[k]!
        const rest = w.slice(k + 1)
        if (f === 'a') c.all = true
        else if (f === 'e') edits = true
        else if (f === 'o' || f === 'i' || f === 'p') c.partial = true
        else if (f === 'm' || f === 'F' || f === 'C' || f === 'c') {
          const value = rest !== '' ? rest : args[(j += 1)]
          if (f === 'm') take(value)
          else if (f === 'F') c.file = value ?? null
          else if (f === 'C') c.reuse = value ?? 'HEAD'
          else c.unknown = true
          break
        }
      }
    } else c.partial = true
  }
  if (c.file === '-') {
    c.file = null
    if (heredocs.length > 0) c.messages.push(...heredocs)
    else c.unknown = true
  }
  if (amend && c.messages.length === 0 && c.file === null && c.reuse === null) {
    if (edits === false) c.reuse = 'HEAD'
    else c.unknown = true
  }
  if (edits === true) c.unknown = true
  // No message at all opens an editor nobody can read here.
  if (c.messages.length === 0 && c.file === null && c.reuse === null && !amend) c.unknown = true
  return c
}

// Words before a claim that negate it or ask for a check instead of reporting one.
const HEDGE_BEFORE =
  /\b(not|n't|no|never|no longer|fail(s|ed|ing|ure)?|broke(n)?|unless|previously|used to|should|will|would|until|when|if|todo|wip|make|get|keep|ensure|help|let|so that|hopefully|maybe|might)\b/i
// Words after a claim that put it in another time or condition.
const HEDGE_AFTER = /\b(when|if|unless|until|except|before|previously|earlier|yesterday|on main|locally only)\b/i
const PASS = '(?:pass(?:es|ed|ing)?|green|ok|clean)'
// The pass verb must end the claim: "tests pass", "tests pass now", not "the test passes the token".
const ENDS = '(?=\\s*(?:$|[.!,;)\\]]|\\s+(?:now|again|locally|on\\s+ci|in\\s+ci|for\\s+me|✅|and|but|with|without|after)\\b))'
const CLAIM: [ProofKind | 'all', RegExp][] = [
  ['tests', new RegExp(`\\b(?:all\\s+)?(?:unit\\s+|integration\\s+|e2e\\s+)?(?:tests|specs|test suite|test)\\s*:?\\s+(?:(?:are|is|now|all|still)\\s+)*${PASS}${ENDS}`, 'i')],
  ['typecheck', new RegExp(`\\b(?:type-?checks?|typecheck(?:s|ing)?|tsc|type checking|types)\\s*:?\\s+(?:(?:is|are|now|still)\\s+)*${PASS}${ENDS}`, 'i')],
  ['lint', new RegExp(`\\b(?:lint(?:s|ing|er)?|eslint|ruff)\\s*:?\\s+(?:(?:is|are|now|still)\\s+)*${PASS}${ENDS}`, 'i')],
  ['build', new RegExp(`\\bbuilds?\\s*:?\\s+(?:(?:is|are|now|still)\\s+)*(?:${PASS}|succeed(?:s|ed)?)${ENDS}`, 'i')],
  ['all', /\ball\s+(?:checks?\s+)?(?:are\s+)?(?:green|passing|pass(?:ed)?)\b|\b(?:ci|checks)\s*:?\s+(?:is\s+|are\s+)?(?:green|passing|passed)\b/i],
]
const KIND_WORDS: [ProofKind, RegExp][] = [
  ['lint', /\blint/i], ['typecheck', /\btype|\btsc/i], ['build', /\bbuild/i], ['tests', /\btest/i],
]

// The checks a message reports as passing. Hedges count per clause, so
// "Tests pass, build skipped" still claims tests.
export function claimsIn(message: string): Array<ProofKind | 'all'> {
  return [...new Set(clauses(message).flatMap(clause => claimsOf(clause).kinds))]
}

// Kinds an "all checks pass except lint" leaves out.
export function exceptionsIn(message: string): ProofKind[] {
  return [...new Set(clauses(message).flatMap(clause => claimsOf(clause).except))]
}

const clauses = (message: string) => message.split(/\n|[.!?;,]\s+|\s+(?:but|while|though)\s+/i)

function claimsOf(clause: string): { kinds: Array<ProofKind | 'all'>; except: ProofKind[] } {
  const kinds: Array<ProofKind | 'all'> = []
  const except: ProofKind[] = []
  for (const [kind, re] of CLAIM) {
    const m = re.exec(clause)
    if (m === null) continue
    if (HEDGE_BEFORE.test(clause.slice(0, m.index))) continue
    const after = clause.slice(m.index + m[0].length)
    if (kind === 'all') {
      const ex = /\bexcept\b(.*)$/i.exec(after)
      if (ex !== null) for (const [k, w] of KIND_WORDS) if (w.test(ex[1] ?? '')) except.push(k)
      if (HEDGE_AFTER.test(after.replace(/\bexcept\b.*$/i, ''))) continue
    } else if (HEDGE_AFTER.test(after)) continue
    kinds.push(kind)
  }
  return { kinds, except }
}

export function resolvePath(from: string, to: string): string {
  const parts = (to.startsWith('/') ? to : `${from}/${to}`).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return `/${out.join('/')}`
}
