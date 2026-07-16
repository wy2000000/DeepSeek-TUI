// Live acceptance on DeepSeek Flash and GLM-5-Turbo measured the inherited
// read-only prompt/tool envelope at 17,457 and 17,550 tokens before the first
// useful tool turn completed. Budget 24k per intended model turn, then pair
// that token allowance with a small max_steps bound so every role has usable
// headroom without becoming open-ended. The five role caps total 360k.
export default workflow({
  "id": "stopship-release-acceptance",
  "goal": "Verify the current Codewhale Fleet, Workflow, Lane, Runtime, and gate receipt path without changing the workspace",
  "description": "Version-neutral, read-only release acceptance fixture. Every Fleet role inspects checked-in runtime evidence; no step creates branches, edits files, installs dependencies, or publishes anything.",
  "gates": [
    {
      "id": "scout-evidence",
      "role": "scout",
      "on": "role_complete",
      "gate": "approve",
      "on_fail": "block",
      "blocks_role": "implementer",
      "max_retries": 0,
      "artifact_kind": "source_evidence",
      "require_explicit_verdict": true
    },
    {
      "id": "implementation-plan",
      "role": "implementer",
      "on": "role_complete",
      "gate": "approve",
      "on_fail": "block",
      "blocks_role": "reviewer",
      "max_retries": 0,
      "artifact_kind": "verification_plan",
      "require_explicit_verdict": true
    },
    {
      "id": "review-findings",
      "role": "reviewer",
      "on": "role_complete",
      "gate": "review",
      "on_fail": "block",
      "blocks_role": "verifier",
      "max_retries": 0,
      "artifact_kind": "review_report",
      "require_explicit_verdict": true
    },
    {
      "id": "verifier-evidence",
      "role": "verifier",
      "on": "role_complete",
      "gate": "verify",
      "on_fail": "block",
      "blocks_role": "release_lead",
      "max_retries": 0,
      "artifact_kind": "verification_report",
      "require_explicit_verdict": true
    }
  ],
  "nodes": [
    {
      "sequence": {
        "id": "acceptance-chain",
        "children": [
          {
            "agent": {
              "id": "scout-runtime",
              "prompt": "Read only the five files in File scope and verify the release-orchestration owners. You have at most four model responses and must reserve the verdict. Use `grep_files` first: response 1 may call only targeted `grep_files` on exact file paths, never a broad `path: crates`, using these symbols: `stopship-release-acceptance|scout-evidence` in workflows/stopship.workflow.js; `name = \"stopship\"|implementer = \"builder\"|release_lead = \"manager\"` in fleets/stopship.toml; `workflow_source_candidates|load_named_fleet|workflow_exec_command|start_lane` in crates/cli/src/lib.rs; `resolve_workflow_agent|resolved_profile` in crates/workflow/src/role_resolve.rs; and `record_task_started|GateUpdated|RunCompleted|stopship_acceptance_fixture_emits_role_gate_and_terminal_receipts` in crates/tui/src/tools/workflow.rs. Keep each grep to at most 16 results and 2 context lines. Response 2 may use `read_file` only on bounded relevant snippets around those matches, at most eight reads and 60 lines per read. Response 3 must return the verdict with no tool calls. Do not follow definitions outside File scope. A concrete call site, typed event constructor, or exact test assertion in a scoped file counts as source-owner evidence. If any required evidence is still missing or ambiguous after response 2, return BLOCK instead of searching again. The first non-empty line of your response must be exactly APPROVE or exactly BLOCK. Use APPROVE only when the evidence covers the stopship alias, named Fleet loading, role-to-profile resolution, tmux Lane launch, typed task_started, gate_updated, and terminal run_completed receipts. Follow with concise `path: symbol` evidence for all seven items. Do not edit files, create branches, run shell commands, access GitHub, or infer success where source evidence is absent.",
              "agent_type": "explore",
              "role": "scout",
              "mode": "read_only",
              "file_scope": [
                "workflows/stopship.workflow.js",
                "fleets/stopship.toml",
                "crates/cli/src/lib.rs",
                "crates/workflow/src/role_resolve.rs",
                "crates/tui/src/tools/workflow.rs"
              ],
              "budget": { "max_steps": 4, "timeout_secs": 480, "max_tokens": 96000 }
            }
          },
          {
            "agent": {
              "id": "plan-verification",
              "prompt": "Act as the Fleet implementer role for a verification-only acceptance run. Use the promoted scout source_evidence handoff to produce a no-edit verification plan for the Fleet/Workflow/Lane/Runtime contract. You have at most three model responses and must reserve the verdict. If the handoff is sufficient, return the verdict immediately. Otherwise response 1 may use `grep_files` first on exact file paths in File scope, response 2 may use `read_file` only on bounded relevant snippets around those matches, and response 3 must return APPROVE or BLOCK with no tool calls. Never search a broad directory or read an entire large source file; if evidence is still missing after response 2, return BLOCK. The first non-empty line of your response must be exactly APPROVE or exactly BLOCK. Use APPROVE only when the plan names concrete receipt fields for role resolution, gate promotion or blocking, and terminal Lane reconciliation; otherwise use BLOCK. This is deliberately not an implementation task: do not edit files, create branches, run shell commands, or propose fixes unrelated to missing acceptance evidence.",
              "agent_type": "implementer",
              "role": "implementer",
              "mode": "read_only",
              "file_scope": [
                "crates/cli/src/lib.rs",
                "crates/lane/src/registry.rs",
                "crates/tui/src/tools/workflow.rs"
              ],
              "budget": { "max_steps": 3, "timeout_secs": 420, "max_tokens": 72000 }
            }
          },
          {
            "agent": {
              "id": "review-contract",
              "prompt": "Review the promoted verification_plan handoff against the checked-in runtime. You have at most three model responses and must reserve the verdict. If the handoff is sufficient, return the verdict immediately. Otherwise response 1 must use `grep_files` first on exact file paths in File scope for each claimed owner, response 2 may use `read_file` only on bounded relevant snippets around those matches, and response 3 must return APPROVE or BLOCK with no tool calls. Never search a broad directory or read an entire large source file; if evidence is still missing after response 2, return BLOCK. Look specifically for false-green risks: declared role versus resolved profile, gate state versus prose verdict, tmux process exit versus terminal workflow receipt, and a completed Lane with missing child evidence. The first non-empty line of your response must be exactly APPROVE or exactly BLOCK. Use APPROVE only when each claimed receipt has a concrete source owner; otherwise use BLOCK and list the missing evidence. Remain read-only and do not run shell commands or edit anything.",
              "agent_type": "review",
              "role": "reviewer",
              "mode": "read_only",
              "file_scope": [
                "crates/cli/src/lib.rs",
                "crates/lane/src/registry.rs",
                "crates/tui/src/tools/workflow.rs"
              ],
              "budget": { "max_steps": 3, "timeout_secs": 420, "max_tokens": 72000 }
            }
          },
          {
            "agent": {
              "id": "verify-receipts",
              "prompt": "Statically verify the promoted review_report against existing tests and receipt serialization. You have at most three model responses and must reserve the verdict. Response 1 must use `grep_files` first on exact file paths in File scope for the receipt and test symbols, response 2 may use `read_file` only on bounded relevant snippets around those matches, and response 3 must return APPROVE or BLOCK with no tool calls. Never search a broad directory or read an entire large source file; if evidence is still missing after response 2, return BLOCK. Inspect the Workflow and CLI test modules for role-resolved task_started, gate_updated, run_completed, metadata, and Lane exit-receipt assertions. The first non-empty line of your response must be exactly APPROVE or exactly BLOCK. Use APPROVE only when every required receipt has an exact test name or source symbol; otherwise use BLOCK. Follow with a compact evidence matrix. Do not run commands, edit files, or create build artifacts; the host gate interprets the explicit first-line verdict.",
              "agent_type": "verifier",
              "role": "verifier",
              "mode": "read_only",
              "file_scope": [
                "crates/cli/src/lib.rs",
                "crates/lane/src/registry.rs",
                "crates/tui/src/tools/workflow.rs"
              ],
              "budget": { "max_steps": 3, "timeout_secs": 420, "max_tokens": 72000 }
            }
          },
          {
            "agent": {
              "id": "release-receipt",
              "prompt": "Use the promoted verification_report handoff to produce the final acceptance receipt for the Fleet/Workflow/Lane/Runtime contract. You have at most two model responses. Return the verdict on response 1 when the promoted handoff is sufficient. If one confirmation round is necessary, response 1 may use `grep_files` first on exact file paths in File scope or use `read_file` only on bounded relevant snippets at paths and lines already named by the handoff; response 2 must return APPROVE or BLOCK with no tool calls. Never search a broad directory or read an entire large source file; if anything remains missing after the one confirmation round, return BLOCK. The first non-empty line of your response must be exactly APPROVE or exactly BLOCK. Use APPROVE only when the receipt includes declared Fleet role and resolved profile evidence, every observed gate state, and the required terminal workflow status; otherwise use BLOCK and name the closure blocker. Never claim that source inspection substitutes for a live Lane log. Do not edit, publish, close issues, run shell commands, or mutate the workspace.",
              "agent_type": "general",
              "role": "release_lead",
              "mode": "read_only",
              "file_scope": [
                "crates/cli/src/lib.rs",
                "crates/lane/src/registry.rs",
                "crates/tui/src/tools/workflow.rs"
              ],
              "budget": { "max_steps": 2, "timeout_secs": 300, "max_tokens": 48000 }
            }
          }
        ]
      }
    }
  ]
});

