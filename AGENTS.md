# AGENTS.md — working rules for coding agents

Rules for AI agents (and anyone acting as one) working in this repository.
Project-specific details live in the repo's own documentation — read
[`product.md`](product.md) for what Simple VTT is and
[`architecture.md`](architecture.md) for how it is built before touching
code. Codebase layout and rendering pipeline: `docs/ARCHITECTURE.md`.

## Commit policy

- **Commit and push only on the user's explicit demand.** Finishing a
  task or passing tests is never consent to commit.
- **Sole exception — quality-check rounds**: when the user asks for a
  quality check (or when the quality-fix loop below is running), the agent
  is autonomous: it commits and pushes its fixes on its own so the fresh
  analyses (Sonar, CodeQL) run, without asking each time.
- If the user asks to hold for local testing ("do not commit until I test
  locally"), report "done, ready to test" and stop — don't ask again; wait
  for an explicit go.
- Conventional-commit style, English (`feat:`, `fix:`, `refactor:`,
  `docs:` …), body bullets explaining the why. Feature work on `feat/*`
  branches opened as PRs. Quality-fix iterations on the same branch/PR.
- When the working tree contains files the agent did not create, inspect
  them and say so before staging everything.

## Agent-local files are never committed

- **Never stage or commit agent-specific directories and files**
  (`.zcode/`, `.claude/`, `.agents/`, `.cursor/`, `.aider*`, and the like).
  They are machine-local configuration, not project content. The repo
  `.gitignore` covers them; if it doesn't yet, propose adding it rather
  than committing these paths.

## Quality gates

When asked for a quality check on a branch or PR — and before calling
implementation work done — inspect all three sources:

1. **SonarCloud / SonarQube** — issues on new code and the quality-gate
   status for the PR.
2. **CodeQL** — code-scanning alerts and review comments posted by
   github-advanced-security.
3. **PR comments** — bot and human comments (conversation comments and
   inline review comments).

## Iteration policy

Fix what was found, push, wait for the fresh analyses, then check all three
sources again — repeating until everything is clean.

**During these fix/verify rounds the agent is autonomous**: it commits and
pushes each fix itself (this is the only case where committing without an
explicit user demand is allowed — see Commit policy), within the
quality-check scope only. It does not use that autonomy to commit anything
unrelated to the findings.

**Stop rule: 3 iterations maximum, autonomously.** After 3 fix/verify
iterations, stop and report the remaining findings with what was tried;
wait for the user's decision before running more iterations.

## Testing stance

- **Do not build heavy test suites unless asked.** Verify by compiling,
  building the Docker image and exercising the real endpoints/pages.
- Verification patterns that work here: two throwaway instances on scratch
  ports (180xx) with temp `DB_PATH`/`UPLOADS_DIR` for round trips
  (backup → fresh restore → archived login); `curl` for API checks; the
  in-app browser for UI checks.
- When a request says "do less tests and go on with the task", move
  forward — don't stall on ceremony.

## Workflow (OpenSpec)

- Feature work goes through the `opsx` commands: `/opsx:propose` (planning
  artifacts only — never implement in the same turn), `/opsx:apply`
  (implement task-by-task, mark checkboxes as you go), `/opsx:archive`
  (completed changes move to `openspec/changes/archive/<date>-<name>/`,
  deltas synced into the main specs).
- `/opsx:update` revises existing planning artifacts coherently when the
  user changes direction mid-plan (e.g. restore moved from the admin panel
  to a first-start wizard).
- Specs describe observable behavior (WHEN/THEN scenarios) — they are the
  acceptance criteria; `design.md` records decisions *and rejected
  alternatives* with rationale.
- **Documentation is part of the workflow**: planning artifacts, spec
  syncs, and the `product.md` / `architecture.md` updates implied by a
  change are maintained as the change progresses, not deferred.
  `/opsx:archive` happens only once the docs reflect the implemented
  behavior.

## Product & architecture documentation

`product.md` and `architecture.md` are mandatory and kept up to date as
part of development, not as an afterthought:

- Maintain them continuously: any feature, refactor, or infrastructure
  change that alters behavior, structure, or deployment includes the
  corresponding doc update — same change, same commit series.
- When starting a task, read both first; if the code and the docs
  disagree, surface the discrepancy instead of silently trusting either.

## Documentation edits need approval

`AGENTS.md`, `product.md`, and `architecture.md` are never edited silently
beyond the upkeep duty above: substantive changes (new decisions, scope
changes, removed sections) are proposed to the user and applied after
approval. Routine sync of facts an approved change already implies goes in
directly.

## Code conventions that came out of review rounds

- Express 5: named splat params (`/uploads/*splat`), no bare `'*'`
  wildcards; async handlers for `await`.
- Streaming first: uploads stream to disk with explicit Content-Length
  gates (never buffered wholesale); backup/restore streams zip entries.
- Validate-then-swap for destructive operations (restore): stage, validate
  fully, write a marker, exit, swap at next boot — never hot-swap a live
  WAL database.
- New Sonar findings: fix properly when the pattern is wrong; mark with
  `// NOSONAR: <rationale>` only when the flagged code is deliberate
  (e.g. sequential storage awaits).
- User-facing errors must reach the user: wait screens, error text, and
  auto-recovery (poll + redirect) for long operations.

## Repo-specific extras

- Dependabot minor bumps are safe to merge.

## Keeping this file honest

Delete any section above that doesn't apply to this repository, and add
repo-specific sections (stack conventions, build/test commands) below.
Where this file and the org template (`radixhomework/default-template`)
disagree, this repository's version prevails.
