# v0.8.67 Constitution Setup Current-Build Evidence

This note records current-build text/render evidence for the v0.8.67
constitution-first setup lane. It complements
`docs/evidence/v0867-constitution-setup-qa-matrix.md`; it is not a release
tag, artifact, or publish record.

- Date: 2026-07-01T07:03:18Z
- Branch: `claude/v0.8.67-constitution-setup-174rj9`
- Head: `3509fe291`
- Workspace version observed in `Cargo.toml`: `0.8.66`

## Covered Surfaces

These checks cover the text-snapshot side of the #3412 release-docs request:

- `/setup` constitution step at blocker terminal sizes `80x24`, `100x30`,
  `120x32`, and `160x40`.
- `/setup` provider/model readiness, runtime posture, constitution choice,
  guided preview/save, update checkpoint, skip/retry, verification report, and
  zh-Hans checkpoint copy.
- `/constitution` manager, preview, edit/repair/bundled/repo/explain/posture
  help paths, including zh-Hans manager/preview copy.
- Prompt injection for the user-global
  `<codewhale_user_constitution>` block and suppression for bundled/deferred or
  expert-override choices.
- `codewhale doctor --json` setup state derivation and persisted-state readback.
- Context report constitution/WHALE.md migration diagnostics without loading
  legacy `WHALE.md` bodies.
- Locale JSON validity for the shipped setup locale files.

## Commands Run

```sh
cargo test -p codewhale-tui --bin codewhale-tui --locked setup_wizard_is_usable_and_opaque_at_blocker_sizes -- --nocapture
```

Result: 1 passed, 0 failed.

```sh
cargo test -p codewhale-tui --bin codewhale-tui --locked constitution -- --nocapture
```

Result: 41 passed, 0 failed.

```sh
cargo test -p codewhale-tui --bin codewhale-tui --locked setup -- --nocapture
```

Result: 106 passed, 0 failed.

```sh
cargo test -p codewhale-tui --bin codewhale-tui --locked context_report -- --nocapture
```

Result: 10 passed, 0 failed.

```sh
cargo test -p codewhale-tui --bin codewhale-tui --locked doctor_setup -- --nocapture
```

Result: 2 passed, 0 failed.

```sh
cargo test -p codewhale-tui --bin codewhale-tui --locked verification_report -- --nocapture
```

Result: 2 passed, 0 failed.

```sh
jq empty crates/tui/locales/en.json crates/tui/locales/es-419.json crates/tui/locales/ja.json crates/tui/locales/pt-BR.json crates/tui/locales/vi.json crates/tui/locales/zh-Hans.json crates/tui/locales/zh-Hant.json
```

Result: passed.

## Remaining Manual Evidence

Before the release is called ready, keep the final manual pass from the QA
matrix: open a current TUI build and visually confirm the same flow through
`/setup`, `/constitution`, `/setup report`, `doctor --json`, and
`doctor --context-json`. This file records automated current-build coverage,
not a human visual acceptance pass.
