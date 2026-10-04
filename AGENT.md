# AGENT.md — working rules for coding agents

Read [`product.md`](product.md) for what Simple VTT is and
[`architecture.md`](architecture.md) for how it is built before touching
code.

## Quality check (when the user asks for a "quality check")

When asked to run or check quality on a branch or PR, always inspect all
three sources before reporting or fixing:

1. **SonarCloud analysis** — issues on new code and the quality-gate status
   for the PR.
2. **CodeQL analysis** — code-scanning alerts and review comments posted by
   github-advanced-security.
3. **PR comments** — bot and human comments on the pull request
   (conversation comments and inline review comments).

## Iteration policy

Fix what was found, push, wait for the fresh analyses, then check all three
sources again — repeating until everything is clean.

**Stop rule: 3 iterations maximum, autonomously.** After 3 fix/verify
iterations, stop and report the remaining findings with what was tried;
wait for the user's decision before running more iterations.

## Commits & branches

- **Always wait for the user's explicit approval before committing or
  pushing** — never commit unprompted, even when the user asked for the fix
  itself.
- Conventional-commit style, English (`feat:`, `fix:`, `refactor:`,
  `docs:` …), body bullets explaining the why.
- Feature work happens on `feat/*` branches, opened as PRs; dependabot
  minor bumps are safe to merge.
- When the working tree contains files the agent did not create, inspect
  them and say so before staging everything.

## Testing stance

- **Do not build heavy test suites unless asked.** Verify by compiling,
  building the Docker image and exercising the real endpoints/pages.
- Verification patterns that work here: two throwaway instances on scratch
  ports (180xx) with temp `DB_PATH`/`UPLOADS_DIR` for round trips
  (backup → fresh restore → archived login); `curl` for API checks; the
  in-app browser for UI checks.
- When a request says "do less tests and go on with the task", move
  forward — don't stall on ceremony.

## OpenSpec workflow

- Feature work goes through the `opsx` commands: `/opsx:propose` (planning
  artifacts only — never implement in the same turn), `/opsx:apply`
  (implement task-by-task, mark checkboxes as you go), `/opsx:archive`
  (completed changes move to `openspec/changes/archive/<date>-<name>/`).
- `/opsx:update` revises existing planning artifacts coherently when the
  user changes direction mid-plan (e.g. restore moved from the admin panel
  to a first-start wizard).
- Specs describe observable behavior (WHEN/THEN scenarios); design.md
  records decisions *and rejected alternatives* with rationale.

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
