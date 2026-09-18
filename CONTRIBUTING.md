# Contributing to Remember

Thanks for your interest in contributing! Remember is an open-source memory
gateway for AI agents, and we welcome contributions from everyone — whether
you're fixing a typo, reporting a bug, or building a whole new feature.

Please take a moment to read our [Code of Conduct](CODE_OF_CONDUCT.md) — we
expect everyone to follow it in all project spaces and interactions.

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Getting started](#getting-started)
- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [How to contribute code](#how-to-contribute-code)
- [Commit guidelines](#commit-guidelines)
- [Testing](#testing)
- [Style guide](#style-guide)
- [Reporting issues](#reporting-issues)

## Ways to contribute

- **Report bugs** — open an issue with a clear reproduction.
- **Suggest features** — open an issue describing the problem you want to solve.
- **Improve documentation** — typos, examples, architecture notes.
- **Write code** — bug fixes, new features, refactors.
- **Review pull requests** — help maintain code quality.

## Getting started

1. **Fork** the repository on GitHub.
2. **Clone** your fork:

   ```bash
   git clone https://github.com/<your-username>/Remember.git
   cd Remember
   ```

3. **Add the upstream remote**:

   ```bash
   git remote add upstream https://github.com/Mahadi-rsio/Remember.git
   ```

4. **Install dependencies** (we use [Bun](https://bun.sh)):

   ```bash
   bun install
   ```

## Development setup

Create your local secrets file:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and set `UPSTREAM_API_KEY` (your main AI key) and `DATABASE_URL`
(a [Neon](https://neon.tech) PostgreSQL connection string). Apply migrations:

```bash
bun run db:migrate
```

Start the dev server:

```bash
bun run dev        # → wrangler dev → http://localhost:8787
```

## Project structure

```text
src/                # Gateway source (Hono, Cloudflare Workers)
web/                # React + shadcn chat UI (bundled into the Worker)
memory-core/        # Astro + React landing page (static site)
tests/              # bun test suite
drizzle/            # Generated SQL migrations
```

## How to contribute code

1. **Sync with upstream** and create a feature branch:

   ```bash
   git fetch upstream
   git checkout -b feat/my-feature upstream/main
   ```

2. **Make your changes.** Keep them focused and small — one logical change per PR.

3. **Add or update tests** for your changes.

4. **Run the checks**:

   ```bash
   bun test               # test suite
   bun run typecheck      # tsc --noEmit
   ```

5. **Commit** your changes (see [Commit guidelines](#commit-guidelines)).

6. **Push** and open a pull request:

   ```bash
   git push origin feat/my-feature
   ```

   Then open a pull request from your fork on GitHub, targeting `main`.

### Working in the landing page (`memory-core/`)

```bash
cd memory-core
bun install
bun run dev            # → http://localhost:4321
bun run build          # static site into dist/
bun run check          # astro check (type checking)
```

## Commit guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>
```

Common types:

- `feat` — a new feature
- `fix` — a bug fix
- `docs` — documentation only
- `refactor` — code change that neither fixes a bug nor adds a feature
- `test` — adding or updating tests
- `chore` — maintenance, dependencies, tooling

Examples:

```
feat(memory): add short-term context with TTL
fix(retrieval): handle empty query gracefully
docs: update client setup example
```

Keep the subject line concise and imperative. Reference related issues where
applicable (e.g. `Closes #42`).

## Testing

We use `bun test`. Run the full suite:

```bash
bun test
```

Some integration tests require live services (Neon database, Upstash Redis).
Source the environment from `.dev.vars` before running those:

```bash
export $(grep -E '^(DATABASE_URL|UPSTASH_REDIS)' .dev.vars | xargs)
bun test
```

> **Note:** `.dev.vars` is not auto-loaded by `bun test`.

## Style guide

- **TypeScript** — strict mode is enabled. Prefer explicit types and avoid `any`.
- **Formatting** — [Prettier](https://prettier.io/) with the repo config.
  Run `bun run format` in `web/` / `memory-core/` to auto-format.
- **Naming** — descriptive names; follow the conventions of the file you're editing.
- **No secrets** — never commit `.dev.vars`, API keys, or connection strings.
- **Comments** — write comments that explain *why*, not *what*.

## Reporting issues

When reporting a bug, please include:

- A clear, descriptive title.
- Steps to reproduce.
- Expected vs. actual behavior.
- Relevant logs or error output.
- Environment details (OS, Bun/Node version, provider, etc.).

Feature requests should describe the **problem** you're solving and any
constraints, so maintainers and contributors can discuss the best approach.

---

Thank you for helping make Remember better! 🚀
