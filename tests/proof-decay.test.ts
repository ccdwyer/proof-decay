import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { checkOf, claimsIn, commitOf, exceptionsIn, parse } from '../hooks/shell'

const ok = () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } })
const fail = () => ({ isError: true as const, result: 'exit 1', text: 'exit 1' })
const edited = () => ({ result: { staged: false } })
const check = (cmd: string) => checkOf(parse(cmd).segments[0]!.words)

const world = (on: On) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.cwd', () => ({ value: '/repo' }))
}
const proofsText = async ($: { command: { run: (e: never) => Promise<unknown> } }) =>
  String(((await $.command.run({ command: 'proofs', args: '' } as never)) as { text?: string }).text)

test('parsing honours quotes and operators', async () => {
  const p = parse(`echo 'a; npm test' && npm run lint | tee out`)
  expect(p.segments.map(s => s.words[0])).toEqual(['echo', 'npm', 'tee'])
  expect(p.segments[0]!.words[1]).toBe('a; npm test')
  expect(p.segments.map(s => s.sep)).toEqual(['&&', '|', ''])
  expect(parse('npm test 2>&1').segments.length).toBe(1)
  expect(parse('x=$(npm test)').complex).toBe(true)
  expect(parse('echo done # && npm test').segments.length).toBe(1)
  expect(parse('npm test;').segments[0]!.sep).toBe('')
  expect(parse(`bash -c 'npm test && npm run lint'`).segments.map(s => s.words[1])).toEqual(['test', 'run'])
})

test('scope: only bare whole-project runs count as project', async () => {
  expect(check('npm test')?.scope).toBe('project')
  expect(check('npm run test:unit')?.scope).toBe('scoped')
  expect(check('npx tsc --noEmit -p tsconfig.json')?.scope).toBe('project')
  expect(check('tsc -p packages/a/tsconfig.json')?.scope).toBe('scoped')
  expect(check('pytest tests')?.scope).toBe('scoped')
  expect(check('pytest -x tests/test_api.py')?.files).toEqual(['tests/test_api.py'])
  expect(check('npx jest -t "logs in"')?.scope).toBe('filtered')
  expect(check('cargo test login')?.scope).toBe('scoped')
  expect(check('cargo test --lib')?.scope).toBe('filtered')
  expect(check('go test ./...')?.scope).toBe('project')
  expect(check('go test')?.scope).toBe('scoped')
  expect(check('eslint .')?.scope).toBe('project')
  expect(check('npm test -w api')?.scope).toBe('scoped')
  expect(check('xcodebuild test -scheme App -only-testing:AppTests/One')?.scope).toBe('filtered')
  expect(check('npm test 2>&1')?.scope).toBe('project')
  expect(check('npm test > out.txt')?.scope).toBe('project')
  expect(check('pytest -kfoo')?.scope).toBe('filtered')
  expect(check('npm --workspace=api test')?.scope).toBe('scoped')
  expect(check('pnpm --filter=@app/web test')?.scope).toBe('scoped')
  expect(check('npx -y jest')?.scope).toBe('project')
  expect(check('jest -w 4')?.scope).toBe('project')
  expect(check('vitest -w')).toBeNull()
  expect(check('gradle test --dry-run')).toBeNull()
  expect(check('npm run test --if-present')).toBeNull()
  expect(check('cargo test --workspace')?.wholeWorkspace).toBe(true)
  expect(check('tsc --noCheck')).toBeNull()
  expect(check('tsc --listFilesOnly')).toBeNull()
  expect(check('npx tsc --noEmit --pretty false')?.scope).toBe('project')
  expect(check('pytest --ignore=tests/integration')?.scope).toBe('filtered')
  expect(check('cargo test --workspace --exclude=broken')?.scope).toBe('filtered')
  expect(check('go test -c ./...')).toBeNull()
  expect(check('make -C packages/api test')?.scope).toBe('scoped')
  expect(check('jest --watchAll')).toBeNull()
  expect(check('time -p npm test')?.kind).toBe('tests')
  expect(check('nice -n 10 npm test')?.kind).toBe('tests')
  expect(check('npm run tests')?.scope).toBe('project')
  expect(check('jest --listTests')).toBeNull()
  expect(check('pytest --collect-only')).toBeNull()
  expect(check('tsc --watch')).toBeNull()
  expect(check('npm install lodash')).toBeNull()
})

test('commit messages and claims', async () => {
  const heredoc = `git commit -m "$(cat <<'EOF'\nFix login\n\nAll tests pass.\nEOF\n)"`
  const p = parse(heredoc)
  const c = commitOf(p.segments[0]!.words, p.heredocs)
  expect(c?.messages.join('\n')).toMatch(/All tests pass/)
  expect(commitOf(parse('git -C ../other commit -am "x"').segments[0]!.words, [])?.dirs).toEqual(['../other'])
  expect(claimsIn('All tests pass.')).toEqual(['tests'])
  expect(claimsIn('tests pass when logged out')).toEqual([])
  expect(claimsIn('not all tests pass yet')).toEqual([])
  expect(claimsIn('Manually verified the empty state')).toEqual([])
  expect(claimsIn('lint clean up of imports')).toEqual([])
  expect(claimsIn('Typecheck is clean')).toEqual(['typecheck'])
  expect(claimsIn('Fix login failure, tests pass')).toEqual(['tests'])
  expect(claimsIn('All tests pass without flakes')).toEqual(['tests'])
  expect(claimsIn('no tests pass')).toEqual([])
  expect(claimsIn('make tests pass')).toEqual([])
  expect(claimsIn('improve test pass rate')).toEqual([])
  expect(claimsIn('Ensure types pass through the boundary')).toEqual([])
  expect(claimsIn('builds are green')).toEqual(['build'])
  expect(claimsIn('the test passes the token to the client')).toEqual([])
  expect(claimsIn('The test passed review')).toEqual([])
  expect(claimsIn('tests passed before the refactor')).toEqual([])
  expect(claimsIn('According to CI tests pass')).toEqual(['tests'])
  expect(claimsIn('All checks passed')).toEqual(['all'])
  expect(claimsIn('Tests: passed')).toEqual(['tests'])
  expect(exceptionsIn('all checks pass except lint')).toEqual(['lint'])
  expect(commitOf(parse('git commit -m"tests pass"').segments[0]!.words, [])?.messages).toEqual(['tests pass'])
  expect(commitOf(parse('git commit -m "tests $1"').segments[0]!.words, [])?.unknown).toBe(true)
  expect(commitOf(parse('git commit -c HEAD').segments[0]!.words, [])?.unknown).toBe(true)
  expect(commitOf(parse('git commit a.ts -m x').segments[0]!.words, [])?.partial).toBe(true)
  expect(parse(`true && bash -c 'git commit -m "tests pass"'`).segments.length).toBe(2)
  expect(commitOf(parse('git commit --amend --no-edit').segments[0]!.words, [])?.reuse).toBe('HEAD')
  expect(commitOf(parse('git commit -m "$MSG"').segments[0]!.words, [])?.unknown).toBe(true)
  expect(commitOf(parse('git commit -Fmsg.txt').segments[0]!.words, [])?.file).toBe('msg.txt')
  expect(commitOf(parse('git -C packages -C api commit -m x').segments[0]!.words, [])?.dirs).toEqual(['packages', 'api'])
})

test('a pass goes stale after an edit and fresh again after a rerun', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => (e.tool === 'Edit' ? edited() : ok()))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
  expect(await proofsText($)).toMatch(/tests stale \(1 edit\)/)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(await proofsText($)).toMatch(/tests fresh/)
})

test('a scoped run goes stale on any edit in the repo', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => (e.tool === 'Edit' ? edited() : ok()))
  await $.tool.call({ tool: 'Bash', command: 'pytest tests/test_api.py' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/api.py', old_string: 'a', new_string: 'b' })
  expect(await proofsText($)).toMatch(/tests stale \(1 edit\) \(scoped\)/)
})

test('compound commands do not mint passes', async ($, on) => {
  world(on)
  on('tool.call', () => ok())
  await $.tool.call({ tool: 'Bash', command: 'npm test; true' })
  await $.tool.call({ tool: 'Bash', command: 'npm test || npm run lint' })
  await $.tool.call({ tool: 'Bash', command: "echo 'x; npm test'" })
  expect(await proofsText($)).toMatch(/no verification runs/)
  await $.tool.call({ tool: 'Bash', command: 'cd /repo && npm test' })
  expect(await proofsText($)).toMatch(/tests fresh/)
})

test('a backgrounded run is not recorded', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(await proofsText($)).toMatch(/no verification runs/)
})

test('a commit claiming stale tests pass is refused', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => (e.tool === 'Edit' ? edited() : ok()))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
  const commit = await $.tool.call({ tool: 'Bash', command: 'git commit -am "Fix login. All tests pass."' })
  expect(commit.deny).toMatch(/claims tests pass/)
})

test('a refused commit leaves the proof stale, never failed', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => (e.tool === 'Edit' ? edited() : ok()))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -am "All tests pass."' })
  const text = await proofsText($)
  expect(text).toMatch(/tests stale \(1 edit\)/)
  expect(text).not.toMatch(/failed/)
})

test('a claim chained with other commands is refused', async ($, on) => {
  world(on)
  on('tool.call', () => ok())
  const commit = await $.tool.call({ tool: 'Bash', command: 'npm test && git commit -m "tests pass"' })
  expect(commit.deny).toMatch(/its own command/)
})

test('a scoped failure undermines the whole-project pass', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' && e.command.startsWith('pytest tests') ? fail() : ok()))
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  await $.tool.call({ tool: 'Bash', command: 'pytest tests/test_api.py' })
  const commit = await $.tool.call({ tool: 'Bash', command: 'git commit -m "tests pass"' })
  expect(commit.deny).toMatch(/later scoped run failed/)
})

test('a commit with no claim runs; a fresh pass lets the claim through', async ($, on) => {
  world(on)
  let commits = 0
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.command.startsWith('git commit')) commits += 1
    return ok()
  })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Refactor"' })
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  const commit = await $.tool.call({ tool: 'Bash', command: 'git commit -m "All tests pass"' })
  expect(commit.deny).toBeUndefined()
  expect(commits).toBe(2)
})

test('an unattributable rerun undermines the old pass', async ($, on) => {
  world(on)
  on('tool.call', () => ok())
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test || true' })
  const commit = await $.tool.call({ tool: 'Bash', command: 'git commit -am "All tests pass"' })
  expect(commit.deny).toMatch(/could not be attributed/)
})

test('a failing && chain with harmless parts records the failure', async ($, on) => {
  world(on)
  on('tool.call', () => fail())
  await $.tool.call({ tool: 'Bash', command: 'npm test && echo done' })
  expect(await proofsText($)).toMatch(/tests failed/)
})

test('a failing cd is not a failing test; a newline script records its last check', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' && e.command.startsWith('cd /missing') ? fail() : ok()))
  await $.tool.call({ tool: 'Bash', command: 'cd /missing && npm test' })
  expect(await proofsText($)).toMatch(/no verification runs/)
  await $.tool.call({ tool: 'Bash', command: 'echo start\nnpm test' })
  expect(await proofsText($)).toMatch(/tests fresh/)
})

test('an unreadable message is refused while checks are stale, allowed when fresh', async ($, on) => {
  world(on)
  let commits = 0
  on('tool.call', (_$, e) => {
    if (e.tool === 'Edit') return edited()
    if (e.tool === 'Bash' && e.command.startsWith('git commit')) commits += 1
    return ok()
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const fresh = await $.tool.call({ tool: 'Bash', command: 'git commit -m "$MSG"' })
  expect(fresh.deny).toBeUndefined()
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
  const stale = await $.tool.call({ tool: 'Bash', command: 'git commit --amend --no-edit' })
  expect(stale.deny).toMatch(/cannot be read/)
  expect(commits).toBe(1)
})

test('a nested shell commit in a chain is still judged', async ($, on) => {
  world(on)
  on('tool.call', () => ok())
  const commit = await $.tool.call({ tool: 'Bash', command: `true && bash -c 'git commit -m "All tests pass"'` })
  expect(commit.deny).toMatch(/no whole-project tests run/)
})

test('pushd makes the directory unknown, so a claim there is refused', async ($, on) => {
  world(on)
  on('tool.call', () => ok())
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const commit = await $.tool.call({ tool: 'Bash', command: 'popd && git commit -m "All tests pass"' })
  expect(commit.deny).toMatch(/cannot be pinned/)
})

test('a check hidden in a substitution undermines the old pass', async ($, on) => {
  world(on)
  on('tool.call', () => ok())
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'RESULT=$(npm test) echo done' })
  const commit = await $.tool.call({ tool: 'Bash', command: 'git commit -m "All tests pass"' })
  expect(commit.deny).toMatch(/could not be attributed/)
})

test('a commit after git push in the same call is still allowed', async ($, on) => {
  world(on)
  let commits = 0
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.command.includes('git commit')) commits += 1
    return ok()
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const commit = await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "All tests pass" && git push' })
  expect(commit.deny).toBeUndefined()
  expect(commits).toBe(1)
})

test('a backgrounded shell job is not a pass', async ($, on) => {
  world(on)
  on('tool.call', () => ok())
  await $.tool.call({ tool: 'Bash', command: 'npm test &' })
  expect(await proofsText($)).toMatch(/no verification runs/)
})

test('an unreadable message after an edit in the same call is refused', async ($, on) => {
  world(on)
  on('tool.call', () => ok())
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const commit = await $.tool.call({ tool: 'Bash', command: `sed -i 's/a/b/' src/a.ts && git commit -m "$MSG"` })
  expect(commit.deny).toMatch(/cannot be read in advance/)
})

test('an interrupted rerun casts doubt on the old pass', async ($, on) => {
  world(on)
  let n = 0
  on('tool.call', () => ((n += 1) === 1 ? ok() : { result: { stdout: '', stderr: '', interrupted: true } }))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(await proofsText($)).toMatch(/did not finish/)
})
