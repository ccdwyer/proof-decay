export type ProofKind = 'tests' | 'typecheck' | 'lint' | 'build'

// One verification run: what it checked, in which repo, and whether it still holds.
export type Proof = {
  // Repo (git top level) or directory the check ran in.
  root: string
  kind: ProofKind
  label: string
  // project: a bare whole-project run; scoped: named files, a package or a script variant;
  // filtered: selected tests by name. Only project proofs back a commit message claim.
  scope: 'project' | 'scoped' | 'filtered'
  files: string[]
  status: 'pass' | 'fail'
  at: number
  // Edits seen landing in the root since the run.
  staleEdits: number
  // The workspace fingerprint the run saw; null outside git.
  fingerprint: string | null
  // Why the result is no longer trusted though no edit was seen, else null.
  doubt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'proof-decay': { proofs: Record<string, Proof>; edits: number }
  }
}
