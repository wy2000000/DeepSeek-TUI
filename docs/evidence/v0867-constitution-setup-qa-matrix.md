# v0.8.67 Constitution Setup QA Matrix

This matrix is the release evidence checklist for the v0.8.67
constitution-first setup lane. It ties `/setup`, `/constitution`, doctor,
context reports, and docs to one shared setup-state vocabulary instead of
checking each surface in isolation.

Current-build automated text/render evidence is recorded in
`docs/evidence/v0867-constitution-setup-current-build-evidence.md`.

## Gate Commands

Run these before claiming the setup lane is ready:

```sh
cargo fmt --all -- --check
git diff --check
jq empty crates/tui/locales/en.json crates/tui/locales/es-419.json crates/tui/locales/ja.json crates/tui/locales/pt-BR.json crates/tui/locales/vi.json crates/tui/locales/zh-Hans.json
cargo test -p codewhale-tui --bin codewhale-tui --locked setup -- --nocapture
cargo test -p codewhale-tui --bin codewhale-tui --locked constitution -- --nocapture
cargo test -p codewhale-tui --bin codewhale-tui --locked context_report -- --nocapture
cargo test -p codewhale-tui --bin codewhale-tui --locked doctor_setup -- --nocapture
cargo test -p codewhale-tui --bin codewhale-tui --locked tui::onboarding -- --nocapture
RUSTFLAGS="-D warnings" cargo test -p codewhale-tui --bin codewhale-tui --locked --no-run
cargo test -p codewhale-config --lib
```

## Hermetic Local Setup

Use temp homes so the matrix does not read or mutate a real install:

```sh
tmp="$(mktemp -d)"
export CODEWHALE_HOME="$tmp/codewhale-home"
export HOME="$tmp/home"
export USERPROFILE="$tmp/home"
export DEEPSEEK_CONFIG_PATH="$CODEWHALE_HOME/config.toml"
mkdir -p "$CODEWHALE_HOME" "$HOME"
```

Useful noninteractive probes:

```sh
cargo run -p codewhale-tui --locked -- doctor --json | jq '.setup'
cargo run -p codewhale-tui --locked -- doctor --context-json | jq '.entries[] | select(.source_kind | test("constitution|project_context_warning"))'
```

## Matrix

| Scenario | Expected behavior | Evidence |
| --- | --- | --- |
| Clean home, bundled/default constitution | First-run can complete by choosing language, recording provider readiness as ready or needs-action, reviewing runtime posture, choosing bundled/default, and opening the setup report. | `/setup` `U` on Constitution step; `crates/tui/src/tui/setup/mod.rs::bundled_constitution_commit_marks_checkpoint_complete`; `doctor --json .setup.constitution.choice == "bundled"` |
| Clean home, guided user-global constitution | Guided custom save writes `$CODEWHALE_HOME/constitution.json`, records source/validity/hash/version in `setup_state.json`, and previews the rendered block. | `crates/tui/src/tui/setup/mod.rs::guided_constitution_commit_emits_structured_payload`; `persist_user_constitution_choice_writes_constitution_and_state`; `/constitution preview` |
| Existing user update checkpoint | If the v0.8.67 checkpoint is incomplete, interactive launch opens `/setup`; choosing bundled/default is a valid completion. | `crates/tui/src/tui/setup/mod.rs::wizard_resumes_at_constitution_checkpoint_when_update_incomplete`; `crates/tui/src/tui/ui/tests.rs::setup_checkpoint_opens_after_onboarding_when_due` |
| First-run onboarding handoff | Finishing the legacy Welcome/Language/API/trust gates opens setup when the checkpoint is due, instead of landing straight in chat. | `crates/tui/src/tui/ui/tests.rs::setup_checkpoint_opens_after_onboarding_when_due`; onboarding copy tests |
| Existing valid user-global constitution | `/constitution` reports it as active when setup state does not select bundled/deferred/expert override; prompt assembly injects it as a separate block. | `crates/tui/src/prompts.rs::user_global_constitution_block_is_injected_separately`; `/constitution status` |
| Invalid, empty, or unreadable user-global constitution | Invalid data is not injected, `/constitution preview` points to repair, and setup can reopen the Constitution step. | `crates/tui/src/prompts.rs::invalid_user_global_constitution_is_skipped`; `crates/tui/src/commands/groups/core/constitution.rs::constitution_preview_renders_structured_block` |
| Advanced full base-prompt override | Expert override is labeled separately from guided user-global constitution and can suppress stale user-global injection when selected. | `docs/CONFIGURATION.md` expert override section; prompt/setup-state tests for bundled/deferred/expert choices |
| Headless or skip-onboarding launch | Noninteractive/skip-onboarding paths do not hang on the setup checkpoint; doctor/setup JSON reports incomplete state. | `crates/tui/src/tui/ui/tests.rs::setup_checkpoint_waits_for_onboarding_and_skip_flag`; `doctor_setup_report_json_derives_state_without_sidecar` |
| Non-English setup checkpoint | zh-Hans setup/checkpoint copy is usable enough to complete the checkpoint; other full locale files keep setup tips aligned with `/setup` and `/constitution`. | `crates/tui/src/tui/setup/mod.rs::zh_hans_checkpoint_copy_is_localized`; locale JSON `jq empty` gate |
| Runtime posture boundary | Constitution autonomy guidance never mutates `default_mode`, approval policy, sandbox, network, shell, trust, or MCP permissions. | `crates/config/src/user_constitution.rs::autonomy_renders_as_guidance_not_runtime_control`; `crates/tui/src/tui/setup/mod.rs::runtime_posture_review_confirms_without_config_mutation` |
| Provider/model readiness ready | Setup records provider/model as `verified` when auth or local runtime is ready, and the result is a secret-free summary. | `crates/tui/src/tui/setup/mod.rs::provider_model_review_records_ready_route_and_continues` |
| Provider/model missing key | Setup records provider/model as `needs_action` and continues; final report points to `/provider` or `/model`. | `crates/tui/src/tui/setup/mod.rs::provider_model_review_records_missing_auth_as_needs_action`; `doctor --json .setup.next_actions.provider_model` |
| Custom provider/model route | `/model` can record provider-qualified custom routes without confusing them with the active provider only. | `cargo test -p codewhale-tui --bin codewhale-tui --locked model_picker -- --nocapture` |
| MCP/tools configured or skipped | Optional tools/MCP readiness never blocks constitution checkpoint completion and remains represented with shared setup-step status. | `/setup` Tools/MCP row; setup filter gate |
| Hotbar defaulted or customized | Hotbar setup remains independent of constitution setup; setup/hotbar tests cover defaulted and saved bindings. | `docs/evidence/hotbar-qa-matrix.md`; `cargo test -p codewhale-tui --bin codewhale-tui --locked hotbar -- --nocapture` |
| Remote/runtime skipped | Remote runtime remains optional; skipped/deferred state is recorded through `SetupState` rather than blocking first-run. | `/setup` Remote Runtime row; `skip_and_retry_emit_setup_state_commits` |
| WHALE.md migration | Legacy `WHALE.md` is ignored, reported as migration-needed, and its body is not loaded into prompt or context report. | `context_report_marks_whale_md_ignored_without_loading_body`; `constitution_manager_marks_whale_md_ignored` |
| Final setup report is secret-free | Report names constitution choice, provider readiness, runtime posture, skipped/deferred/needs-action steps, and no raw secrets. | `doctor --json .setup`; `verification_report_records_ready_after_bundled_checkpoint`; `step_result_carries_no_secret_by_construction` |

## Text Snapshot Checklist

Capture these snippets in release notes or PR evidence when cutting the release
candidate:

1. Welcome screen includes "Make CodeWhale yours" and references the CodeWhale
   constitution.
2. `/setup` Provider and Model card shows provider, model, auth state, and
   health without secrets.
3. `/setup` Runtime Posture card says constitution guidance does not change
   runtime policy silently.
4. `/setup` Constitution step shows bundled/default and guided custom actions.
5. `/constitution` overview shows bundled, user-global, repo-local, AGENTS,
   memory/handoff, preview, and maintenance actions.
6. `/setup report` or `codewhale doctor --json | jq '.setup'` shows
   `constitution`, `runtime_posture_source`, `steps`, and `next_actions`.
7. `doctor --context-json` shows repo constitution or WHALE.md migration
   diagnostics without legacy file bodies.
