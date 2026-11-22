# mend

[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vickyair1/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vickyair1/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one command-line tool that applies the edits AI models write, in four formats, to a tree of
text files — to the specification in `SPEC.md`:

- unified diffs (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- V4A patches,
- text-editor tool calls as JSON.

It finds the lines an edit names at the first of three matching tiers (exact, trailing whitespace off,
leading and trailing whitespace off, with re-indentation), and changes every file or none.

## Run it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree. `PATCH` is the patch file, relative to the working
directory; when it is absent or is `-`, the patch is read from standard input. `--format` is `auto`
(the default, which detects the format), `unified`, `search-replace`, `v4a` or `json`. `--check` does
everything but write. `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and
`ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per failed edit and
`failed: <k> of <n> edits`, and writes nothing. Exit 2 prints one line for a usage, missing-patch,
format or parse error.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to
  `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs
  `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine:

      node check.ts ../program/generator/practice.json

- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## Practice score

100 of 100 practice checks pass (score 1000), verified with the kit's `check.ts` against
`program/generator/practice.json`, plus 112 hand-built adversarial checks drawn from SPEC.md
sentences the practice set does not show.

[make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
