import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Proof, ProofKind } from '../types'
import { checkOf, claimsIn, commitOf, exceptionsIn, isHarmless, isInfallible, parse, resolvePath, substitutions, unwrap } from './shell'
import type { Check, Commit } from './shell'

const proofs = atom({ plugin: 'proof-decay', key: 'proofs' } as const, {})
const edits = atom({ plugin: 'proof-decay', key: 'edits' } as const, 0)

const KINDS: ProofKind[] = ['tests', 'typecheck', 'lint', 'build']
const NAMES: Record<ProofKind, string> = { tests: 'tests', typecheck: 'types', lint: 'lint', build: 'build' }
const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])
const DRIFT = 'files changed on disk since the run'
const UNSEEN = 'the repo could not be fingerprinted'
const AMBIGUOUS = 'a later run of it had an outcome that could not be attributed'

// The working tree as git sees it: every tracked or untracked, non-ignored file
// that exists, by path and content id. HEAD and the index are left out, so
// committing the tested tree leaves it unchanged. Filters never run (--no-filters).
const FINGERPRINT = `set -eo pipefail
files=$(mktemp); out=$(mktemp)
trap 'rm -f "$files" "$out"' EXIT
git -c core.quotePath=false ls-files -z -co --exclude-standard --deduplicate | while IFS= read -r -d '' f; do
  if [ -L "$f" ]; then printf 'link %s -> %s\\n' "$f" "$(readlink "$f")" >> "$out"
  elif [ -d "$f" ]; then printf 'sub %s %s\\n' "$f" "$(git -C "$f" rev-parse HEAD 2>/dev/null || echo none)" >> "$out"
  elif [ -f "$f" ]; then
    case "$f" in *$'\\n'*) printf 'odd %s %s\\n' "$f" "$(wc -c < "$f")" >> "$out" ;; *) printf '%s\\n' "$f" >> "$files" ;; esac
    if [ -x "$f" ]; then printf 'exec %s\\n' "$f" >> "$out"; fi
  fi
done
git hash-object --no-filters --stdin-paths < "$files" | paste -d ' ' - "$files" >> "$out"
LC_ALL=C sort "$out"`

const isFresh = (p: Proof) => p.status === 'pass' && p.staleEdits === 0 && p.doubt === null

const describe = (p: Proof) => {
  const scope = p.scope === 'project' ? '' : ` (${p.scope})`
  if (p.status === 'fail') return `✗ ${NAMES[p.kind]} failed${scope}`
  if (p.staleEdits > 0) return `⚠ ${NAMES[p.kind]} stale (${p.staleEdits} edit${p.staleEdits === 1 ? '' : 's'})${scope}`
  if (p.doubt !== null) return `⚠ ${NAMES[p.kind]} stale${scope}`
  return `✓ ${NAMES[p.kind]} fresh${scope}`
}

const keyOf = (root: string, c: { kind: ProofKind; scope: Check['scope']; label: string }) =>
  c.scope === 'project' ? `${root}|${c.kind}|project` : `${root}|${c.kind}|${c.scope}|${c.label}`

const inRoot = (root: string, path: string) => path === root || path.startsWith(`${root}/`)
const ignoredPath = (path: string) => /\/(\.git|node_modules)\//.test(path)

async function hash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes).slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('')
}

type Root = { root: string; git: boolean }
const roots = new Map<string, Root>()
async function rootOf($: EngineInterface, dir: string): Promise<Root> {
  const known = roots.get(dir)
  if (known !== undefined) return known
  let found: Root = { root: dir, git: false }
  try {
    const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
    if (r.exitCode === 0 && r.stdout.trim() !== '') found = { root: r.stdout.trim(), git: true }
  } catch {
    // Not a repo, or git missing: the directory stands for itself.
  }
  roots.set(dir, found)
  return found
}

async function fingerprint($: EngineInterface, root: Root): Promise<string | null> {
  if (!root.git) return null
  try {
    const r = await $.process.run(['bash', '-c', FINGERPRINT], { cwd: root.root, timeoutMs: 30000 })
    if (r.exitCode !== 0 || r.isStdoutTruncated) return null
    return await hash(r.stdout)
  } catch {
    return null
  }
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    await $.fs.stat(path)
    return true
  } catch {
    return false
  }
}

// A run below the repo root, or of one package, checked less than the whole repo.
async function demote($: EngineInterface, check: Check, dir: string, root: string): Promise<Check['scope']> {
  if (check.scope !== 'project') return check.scope
  if (['npm', 'yarn', 'pnpm', 'bun'].includes(check.tool)) {
    // The package manager runs the nearest package.json's script.
    for (let d = dir; inRoot(root, d); d = resolvePath(d, '..')) {
      if (await exists($, `${d}/package.json`)) return d === root ? 'project' : 'scoped'
      if (d === root) break
    }
    return 'project'
  }
  // `cargo test --workspace` covers every member from any directory inside it.
  if (check.tool === 'cargo' && check.wholeWorkspace) return 'project'
  if (dir !== root) return 'scoped'
  if (check.tool === 'cargo') {
    // A root package with a workspace runs only the root package; a virtual
    // workspace with no default-members runs every member.
    try {
      const manifest = await $.fs.read(`${root}/Cargo.toml`)
      const isWorkspace = /^\s*\[workspace\]/m.test(manifest)
      const isPackage = /^\s*\[package\]/m.test(manifest)
      if (isWorkspace && (isPackage || /^\s*default-members\s*=/m.test(manifest))) return 'scoped'
    } catch {
      return 'scoped'
    }
  }
  return 'project'
}

// Compares each repo's files with what its proofs saw. Changes no hook saw (an
// editor, a formatter, a script) make them stale; a tree put back makes them fresh.
async function refresh($: EngineInterface, only?: string) {
  const all = Object.values(await read($, proofs))
  const wanted = [...new Set(all.filter(p => p.fingerprint !== null).map(p => p.root))].filter(r => only === undefined || r === only)
  const now = new Map<string, string | null>()
  for (const root of wanted) now.set(root, await fingerprint($, { root, git: true }))
  if (now.size === 0) return
  await update($, proofs, cur =>
    Object.fromEntries(
      Object.entries(cur).map(([k, p]) => {
        if (p.fingerprint === null || !now.has(p.root)) return [k, p]
        const fp = now.get(p.root) ?? null
        if (fp === null) return [k, p.doubt === null ? { ...p, doubt: UNSEEN } : p]
        if (fp === p.fingerprint) {
          const doubt = p.doubt === DRIFT || p.doubt === UNSEEN ? null : p.doubt
          return [k, { ...p, staleEdits: 0, doubt }]
        }
        return [k, p.doubt === null ? { ...p, doubt: DRIFT } : p]
      }),
    ),
  )
}

async function staleFiles($: EngineInterface, paths: string[]) {
  const real = paths.filter(p => !ignoredPath(p))
  if (real.length === 0) return
  await update($, edits, n => n + 1)
  await update($, proofs, all =>
    Object.fromEntries(
      Object.entries(all).map(([k, p]) => [k, real.some(path => inRoot(p.root, path)) ? { ...p, staleEdits: p.staleEdits + 1 } : p]),
    ),
  )
}

type BashResult = {
  interrupted?: boolean
  backgroundTaskId?: string
  bashEditDiff?: { files?: { filePath: string }[]; changedFiles?: string[] }
}

// dir is null after a directory change this mod cannot follow (popd, cd ~, cd -, cd $X).
type Step = { words: string[]; sep: string; dir: string | null; check: Check | null; commit: Commit | null }

// Whether the commands before a commit stage the whole tree. Only a full-repo
// add counts (-A / --all / :/ with no pathspec, or `.` from the repo root); any
// other add leaves the unstaged and untracked checks in force.
function stagedBefore(steps: Step[], upTo: number, root: string): boolean {
  let all = false
  for (const s of steps.slice(0, upTo)) {
    const argv = unwrap(s.words)
    if (base(argv[0] ?? '') !== 'git') continue
    let i = 1
    let dir = s.dir
    while (argv[i]?.startsWith('-')) {
      if (argv[i] === '-C') {
        dir = dir === null ? null : resolvePath(dir, argv[i + 1] ?? '.')
        i += 2
      } else i += argv[i] === '-c' ? 2 : 1
    }
    if (argv[i] !== 'add') continue
    const args = argv.slice(i + 1)
    if (args.some(a => a === '-n' || a === '--dry-run' || a === '-u' || a === '--update' || a === '-p' || a === '--patch')) continue
    const paths = args.filter(a => !a.startsWith('-'))
    const full = args.some(a => a === '-A' || a === '--all') && paths.length === 0
    if (full || (paths.length === 1 && (paths[0] === ':/' || (paths[0] === '.' && dir === root)))) all = true
  }
  return all
}

const base = (word: string) => word.replace(/^.*\//, '')

// Oathkeeper: the reason to refuse this commit, or null to let it run.
async function judgeCommit($: EngineInterface, steps: Step[], at: number): Promise<string | null> {
  const step = steps[at]!
  const c = step.commit!
  const target = step.dir === null ? null : c.dirs.reduce((d, next) => resolvePath(d, next), step.dir)
  const messages = [...c.messages]
  let unknown = c.unknown
  if (c.retargeted || target === null) {
    // The repo git will write to is not one this mod can pin; a claim cannot be checked.
    const said = claimsIn(messages.join('\n')).length > 0 || unknown || c.reuse !== null || c.file !== null
    if (!said) return null
    return 'Proof Decay: the commit may claim checks pass, but the repo it targets cannot be pinned (--git-dir, --work-tree, GIT_DIR, or a directory change like popd / cd ~ / cd -). Commit from the repo directory without them, or keep claims out of the message.'
  }
  if (c.file !== null) {
    try {
      messages.push(await $.fs.read(resolvePath(target, c.file)))
    } catch {
      unknown = true
    }
  }
  if (c.reuse !== null) {
    try {
      const r = await $.process.run(['git', '-C', target, 'log', '-1', '--format=%B', c.reuse, '--'], { timeoutMs: 5000 })
      if (r.exitCode === 0) messages.push(r.stdout)
      else unknown = true
    } catch {
      unknown = true
    }
  }
  const text = messages.join('\n')
  const claims = claimsIn(text)
  if (claims.length === 0 && !unknown) return null

  const { root, git } = await rootOf($, target)
  // Only what runs before the commit can change what it records.
  if (steps.slice(0, at).some(s => !isHarmless(s.words))) {
    return (
      'Proof Decay: this commit message claims checks pass (or cannot be read in advance), and other commands run before the commit in the same call, ' +
      'so it cannot tell what was verified. Run the checks, then run `git commit` as its own command (git add before it is fine).'
    )
  }
  await refresh($, root)
  const mine = Object.values(await read($, proofs)).filter(p => p.root === root)

  const kinds = new Set<ProofKind>()
  for (const claim of claims) {
    if (claim === 'all') {
      for (const k of ['tests', 'typecheck', 'lint'] as const) kinds.add(k)
      if (mine.some(p => p.kind === 'build' && p.scope === 'project')) kinds.add('build')
    } else kinds.add(claim)
  }
  for (const k of exceptionsIn(text)) kinds.delete(k)
  if (unknown) {
    // A message nobody can read may claim anything: every check must hold, tests at least.
    kinds.add('tests')
    for (const p of mine) if (p.scope === 'project') kinds.add(p.kind)
    const shaky = mine.filter(p => !isFresh(p))
    if (shaky.length > 0) {
      return (
        'Proof Decay: the commit message cannot be read before the commit runs (a shell variable, an editor, or a ' +
        'reused message that could not be read), and some checks in this repo are not fresh: ' +
        `${shaky.map(describe).join('; ')}. Commit with a literal -m message.`
      )
    }
  }
  for (const kind of kinds) {
    const proof = mine.find(p => p.kind === kind && p.scope === 'project')
    const problem =
      proof === undefined ? `no whole-project ${NAMES[kind]} run was recorded in ${root} this session`
      : proof.status === 'fail' ? `the last ${NAMES[kind]} run (\`${proof.label}\`) failed`
      : proof.staleEdits > 0 ? `the last ${NAMES[kind]} run (\`${proof.label}\`) passed, but ${proof.staleEdits} edit(s) landed since`
      : proof.doubt !== null ? `the last ${NAMES[kind]} run (\`${proof.label}\`) passed, but ${proof.doubt}`
      : null
    if (problem !== null) {
      const subject = unknown && claims.length === 0 ? 'the commit message cannot be read, so it must hold for every check, and' : `the commit message claims ${NAMES[kind]} pass, but`
      return (
        `Proof Decay: ${subject} ${problem}. ` +
        `Run the ${NAMES[kind]} again (whole project, from the repo root) and commit only if it passes, or take the claim out of the message.`
      )
    }
  }

  // What was tested is the working tree; what is committed is the index plus what this call stages.
  if (!git) return null
  if (c.partial) {
    return 'Proof Decay: the commit message claims checks pass, but this commit takes only part of the changes (pathspecs, --only, --include or --patch), which is not the tree that was tested. Commit everything that was tested, or take the claim out.'
  }
  const stagedAll = stagedBefore(steps, at, root)
  try {
    if (!(c.all || stagedAll)) {
      const unstaged = await $.process.run(['git', '-C', root, 'diff', '--quiet', '--no-ext-diff'], { timeoutMs: 10000 })
      if (unstaged.exitCode === 1) {
        return (
          'Proof Decay: the commit message claims checks pass, but the working tree has unstaged changes, so the ' +
          'commit is not the tree that was tested. Stage everything that was tested (or use -a), or take the claim out.'
        )
      }
      if (unstaged.exitCode !== 0) throw new Error('git diff failed')
    }
    if (!stagedAll) {
      // -a stages tracked files only: untracked files the tests saw stay out.
      const untracked = await $.process.run(['git', '-c', 'core.quotePath=false', '-C', root, 'ls-files', '-o', '--exclude-standard'], { timeoutMs: 10000 })
      if (untracked.exitCode !== 0) throw new Error('git ls-files failed')
      const names = untracked.stdout.split('\n').filter(Boolean)
      if (names.length > 0) {
        return (
          `Proof Decay: the commit message claims checks pass, but ${names.length} untracked file(s) were part of the tested tree ` +
          `and are not in this commit (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}). ` +
          'Add them (or remove them and rerun the checks), or take the claim out.'
        )
      }
    }
  } catch {
    return 'Proof Decay: the commit message claims checks pass, but git could not report whether the commit matches the tested tree. Try again, or take the claim out.'
  }
  return null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'proofs',
      description: 'Proof Decay: list recorded test/typecheck/lint/build results and whether they still hold ("/proofs clear" forgets them)',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'proofs' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, proofs, () => ({}))
      return { text: 'Proof Decay: all recorded results forgotten.' }
    }
    await refresh($)
    const all = Object.values(await read($, proofs))
    if (all.length === 0) return { text: 'Proof Decay: no verification runs recorded this session yet.' }
    const now = await $.clock.now()
    const lines = all
      .sort((a, b) => a.root.localeCompare(b.root) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || b.at - a.at)
      .map(p => {
        const ago = Math.max(0, Math.round((now - p.at) / 60000))
        const files = p.files.length > 0 ? ` · covers ${p.files.join(', ')}` : ''
        const why = p.doubt !== null ? ` — ${p.doubt}` : ''
        return `${describe(p)} · \`${p.label}\` · ${ago} min ago · ${p.root}${files}${why}`
      })
    return { text: `Proof Decay:\n${lines.join('\n')}` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const parsed = parse(e.command)
    const cwd = await $.session.cwd()

    // Each simple command with the directory it runs in.
    let dir: string | null = cwd
    const steps: Step[] = parsed.segments.map(seg => {
      const argv = unwrap(seg.words)
      const step = { ...seg, dir, check: checkOf(seg.words), commit: commitOf(seg.words, parsed.heredocs) }
      if (argv[0] === 'cd' || argv[0] === 'pushd') {
        const to = argv[1]
        if (to === undefined || /^[~$+-]/.test(to)) dir = null
        else if (dir !== null) dir = resolvePath(dir, to)
      } else if (argv[0] === 'popd') dir = null
      return step
    })

    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i]!.commit === null) continue
      const reason = await judgeCommit($, steps, i)
      if (reason !== null) return { deny: reason }
    }

    const checks = steps.filter((s): s is Step & { dir: string; check: Check } => s.check !== null && s.dir !== null)
    // Checks hidden in $(...) or backticks run too, with outcomes nobody sees.
    const hidden = parsed.complex
      ? substitutions(e.command).flatMap(sub => parse(sub).segments.map(seg => checkOf(seg.words))).filter((c): c is Check => c !== null)
      : []
    const before = new Map<string, string | null>()
    const editsBefore = await read($, edits)
    for (const s of checks) {
      const r = await rootOf($, s.dir)
      if (!before.has(r.root)) before.set(r.root, await fingerprint($, r))
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const result = (ran.result ?? {}) as BashResult
    const failed = ran.isError === true

    // Files the command itself wrote make earlier proofs stale before this run's are recorded.
    const diff = result.bashEditDiff
    const written = [...new Set([...(diff?.changedFiles ?? []), ...(diff?.files?.map(f => f.filePath) ?? [])])]
      .map(p => resolvePath(cwd, p))
      .filter(p => !ignoredPath(p))
    await staleFiles($, written)

    const unfinished = e.run_in_background === true || result.backgroundTaskId !== undefined || result.interrupted === true
    // A check in a directory this mod lost track of, or one that never finished,
    // says nothing new: it only casts doubt on the earlier pass of its kind.
    const lost = steps.filter(s => s.check !== null && s.dir === null).map(s => s.check!)
    const doubtful = unfinished ? [...checks.map(s => s.check), ...hidden, ...lost] : lost
    if (doubtful.length > 0) {
      const root = (await rootOf($, cwd)).root
      await update($, proofs, all => {
        const out: Record<string, Proof> = { ...all }
        for (const c of doubtful) {
          const key = `${root}|${c.kind}|project`
          const p = out[key]
          if (p !== undefined && p.status === 'pass') out[key] = { ...p, doubt: unfinished ? 'a later run of it did not finish' : AMBIGUOUS }
        }
        return out
      })
    }
    if ((checks.length > 0 || hidden.length > 0) && !unfinished) {
      const now = await $.clock.now()
      const editedMeanwhile = (await read($, edits)) !== editsBefore + (written.length > 0 ? 1 : 0)
      const recorded: Record<string, Proof> = {}
      const undermined: { root: string; kind: ProofKind; why: string }[] = []
      const seps = steps.map(s => s.sep)
      const andChain = !parsed.complex && seps.every(sep => sep === '' || sep === '&&')

      for (const c of hidden) undermined.push({ root: (await rootOf($, cwd)).root, kind: c.kind, why: AMBIGUOUS })

      for (const s of checks) {
        const index = steps.indexOf(s)
        const isLast = index === steps.length - 1
        const before_ = seps.slice(0, index)
        // When this check's own outcome can be read from the one exit status the call has.
        let outcome: 'pass' | 'fail' | null = null
        if (!parsed.complex && s.sep !== '&' && s.sep !== '|') {
          if (andChain && !failed) outcome = 'pass'
          else if (andChain && failed && checks.length === 1 && steps.every(o => o === s || isInfallible(o.words))) outcome = 'fail'
          else if (isLast && before_.every(sep => sep === ';' || sep === '&&') && !failed) outcome = 'pass'
          else if (isLast && before_.every(sep => sep === ';') && failed) outcome = 'fail'
        }
        const r = await rootOf($, s.dir)
        if (outcome === null) {
          undermined.push({ root: r.root, kind: s.check.kind, why: AMBIGUOUS })
          continue
        }
        const scope = await demote($, s.check, s.dir, r.root)
        const after = await fingerprint($, r)
        let doubt: string | null = null
        if (outcome === 'pass') {
          const tail = steps.slice(index + 1)
          const otherChecks = checks.length > 1
          if (r.git && after === null) doubt = UNSEEN
          else if (editedMeanwhile) doubt = 'files were edited while it ran'
          else if (after !== before.get(r.root) && (otherChecks || !tail.every(t => isHarmless(t.words)))) doubt = 'files changed during the same command'
        }
        const entry = { kind: s.check.kind, scope, label: s.check.label }
        recorded[keyOf(r.root, entry)] = {
          root: r.root, ...entry, files: s.check.files,
          status: outcome, at: now, staleEdits: 0, fingerprint: after, doubt,
        }
        if (outcome === 'fail' && scope !== 'project') undermined.push({ root: r.root, kind: s.check.kind, why: `a later ${scope} run failed` })
      }
      await update($, proofs, all => {
        const out: Record<string, Proof> = { ...all, ...recorded }
        for (const u of undermined) {
          const key = `${u.root}|${u.kind}|project`
          const p = out[key]
          if (p !== undefined && recorded[key] === undefined && p.status === 'pass') out[key] = { ...p, doubt: u.why }
        }
        return out
      })
    }

    // After a commit, say plainly what in that repo was never re-verified.
    const commit = steps.find(s => s.commit !== null && s.dir !== null)
    if (commit !== undefined && !failed) {
      const target = commit.commit!.dirs.reduce((d, n) => resolvePath(d, n), commit.dir!)
      const { root } = await rootOf($, target)
      await refresh($, root)
      const unverified = Object.values(await read($, proofs)).filter(p => p.root === root && !isFresh(p))
      if (unverified.length > 0) {
        const note =
          'Proof Decay: this commit includes changes that were not re-verified: ' +
          unverified.map(describe).join('; ') +
          '. Say so plainly when you report the commit, or rerun those checks.'
        return { ...ran, context: [...(ran.context ?? []), note] }
      }
    }
    return ran
  })

  on('tool.call', async ($, e, next) => {
    if (!EDITORS.has(e.tool)) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    if ((ran.result as { staged?: boolean } | undefined)?.staged === true) return ran
    const call = e as { file_path?: unknown; notebook_path?: unknown }
    const path = String(call.file_path ?? call.notebook_path ?? '')
    if (path !== '') await staleFiles($, [resolvePath(await $.session.cwd(), path)])
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const cwd = await $.session.cwd()
    const all = Object.values(await read($, proofs)).filter(p => inRoot(p.root, cwd))
    // Per kind: the whole-project run if there is one, else the latest.
    const shown = KINDS.map(kind => {
      const mine = all.filter(p => p.kind === kind)
      return mine.find(p => p.scope === 'project') ?? mine.sort((a, b) => b.at - a.at)[0]
    }).filter((p): p is Proof => p !== undefined)
    if (shown.length === 0) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box>
          {shown.map((p, i) => (
            <Text color={p.status === 'fail' ? 'red' : isFresh(p) ? 'green' : 'yellow'}>
              {i > 0 ? ' · ' : ''}
              {describe(p)}
            </Text>
          ))}
        </Box>
        {below}
      </Box>
    )
  })
}
