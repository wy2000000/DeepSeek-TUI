# CodeWhale Smoothness Playbook — Fixing the "Pop In / Pop Out & Bad Timing" Feeling

Audience: the CodeWhale TUI team. Scope: perceived motion quality — how ephemeral UI (overlays, modals, spinners, toasts, streaming text, transcript cells, sidebar panels) appears, disappears, and coordinates in time. This is the choreography layer that the prior `CODEWHALE_PERFORMANCE_MOTION_AUDIT.md` under-covers. It does not re-litigate raw render micro-perf except where perf causes a *visible* flash or stutter.

---

## 1. Executive summary

**There is exactly one root cause, and it has two faces.**

CodeWhale has **no animation clock**. Redraw is on-demand: `App::needs_redraw: bool` (`app/…`, flipped in 83 places in `app.rs` alone) is the *only* signal that a frame should be produced, and `frame_rate_limiter.rs` is a pure *throttle* — `clamp_deadline()` (frame_rate_limiter.rs:55–63) only pushes a requested draw *later* so two draws never land closer than `MIN_FRAME_INTERVAL` (8.33ms, frame_rate_limiter.rs:36). Nothing ever ticks the UI *forward* in time on its own. Because state can only advance when an event arrives, **every state change is a single-frame snap**: an overlay is absent on frame N and fully present on frame N+1. There are no in-between frames to ease through, so nothing can fade, slide, or grow. This is *face one*: **no clock → everything snaps.**

Layered on top is *face two*: **no shared timing scale.** There are 40+ magic durations scattered across ~30 files (spinner 80ms, forced-repaint cadence 80ms, streaming hysteresis 1200ms/300ms/250ms, toast TTLs 4s/5s/15s, receipt 8s, version hint 12s, thinking throttle 100ms) with no central module and no easing vocabulary anywhere in the crate. Even if two surfaces *did* animate, they'd move at unrelated tempos. This is why the UI feels "uncoordinated" even in the places that technically do move (the spinner and the footer working-strip drift against each other).

Put together: **things pop instead of transition (no clock), and the few things that do move feel unrelated (no scale).** That is the entire complaint.

The 3–4 highest-leverage moves, in order:

1. **Build the animation clock.** A single scheduler that, whenever anything is mid-transition, forces a redraw at a steady ~30–60fps and idles otherwise. This is the keystone — nothing else in the "smooth" column is possible without it. (Section 3.)
2. **Add a `motion::timing` token module** — `INSTANT/FAST/BASE/SLOW` durations, a 2–3 curve easing set, and the spinner delay/min-visible constants — and route the existing 40+ magic numbers through it. (Section 3.)
3. **Ship the quick wins that need no clock first** — spinner show-delay + min-visible-time, unified 80ms spinner cadence, kill the full-terminal-clear on resize/focus, and minimum-dwell on toasts. These remove the *worst* flashes immediately and buy goodwill while the clock lands. (Section 5A.)
4. **Give each surface a real enter/exit** — a small, uniform fade+offset on overlays/modals/toasts/panels driven by the clock and the tokens. Symmetry is the point: things should leave the way they arrived. (Section 4, Section 5B.)

---

## 2. Why it feels ugly today — the mental model

CodeWhale's render loop is **event-driven snap rendering**. Walk the loop in `ui.rs`: an input or engine event arrives, a handler mutates state and sets `app.needs_redraw = true`, and the draw gate (`if needs_redraw && draw_wait.is_none()`, ui.rs:~3493–3503) paints once. Between events the loop *sleeps* on the next terminal event. `frame_rate_limiter.rs` caps how *fast* this can happen; nothing makes it happen *on a rhythm*. The consequence is structural: **a transition that should take 150ms cannot exist**, because there is no mechanism to wake the loop 5 times over those 150ms to advance it. Every "before" state is one frame; every "after" state is the next frame.

Everything the user perceives as "ugly timing" is a symptom of that one fact, expressed on different surfaces:

- **Boolean overlay toggles.** Overlays are a `ViewStack` of boxed `ModalView`s. `ViewStack::push()` (views/mod.rs:795) synchronously appends the view; the next draw renders it at full size and opacity via `render_modal_surface`/`render_modal_backdrop` (views/mod.rs:64–102), which paint an opaque block in one pass with no alpha/scale parameter. `ViewStack::apply_action()` handling `ViewAction::Close` (views/mod.rs:876–880) calls `pop()` immediately. No modal struct — `ApprovalView` (approval.rs:1329–1354), `CommandPaletteView` (command_palette.rs:54–59), `ModelPickerView` (model_picker.rs:51–76), `ContextMenuView` (context_menu.rs:34–44) — carries an `entering_at`, `exit_progress`, `opened_at`, or `min_visible` field. A grep for `animation_frame` across the whole `tui/` tree returns zero hits. So the command palette, model/provider/session/file pickers, slash menu, feedback picker, pager, backtrack, context inspector, and the **approval modal** (the single most weighty surface, pushed at ui.rs:10410, popped on `EmitAndClose` at approval.rs:1405) all pop and vanish in one frame, backdrop included.

- **Flashing / stuttering spinners.** `braille_spinner_frame()` (spinner.rs:40–50) derives its frame index purely from `started.elapsed() / 80ms`. It is only ever called *inside a render pass*. So the spinner only advances when *something else* triggers a redraw. If the app is idle for >80ms — network stall, user not typing — `needs_redraw` stays false, the spinner freezes, and when an unrelated event finally fires it jumps several frames at once (visible stutter). Worse, there is **no show-delay and no min-visible-time**: a tool status flips to `Running` and the spinner renders immediately (history.rs:1605–1612, 1710–1735), and flips to `Success` and it vanishes immediately (footer_ui.rs:258–264 gates purely on `is_loading`; sidebar.rs:1680–1686 returns `None` the instant status != running). A sub-100ms op flashes a glyph for one or two frames — reads as a glitch, not "working."

- **Inconsistent spinner tempos.** The braille spinner runs at 80ms/frame (spinner.rs:15). The footer working-label uses `now_ms / 400` (footer_ui.rs:267–268) — a different cadence entirely. Sidebar task spinners sample `braille_spinner_frame_for_duration_ms(task.duration_ms)` (sidebar.rs:1683) independently. Each surface reads the wall clock on its own with no shared frame counter, so when the footer, an active tool card, and a sidebar task are all spinning at once they visibly beat against each other.

- **Layout jumps.** New transcript cells materialize at full height in a single frame: `flatten_from()` appends the cell's full line vector at once (transcript.rs:282–299), shoving existing content upward. When sticky-to-bottom is active, `scroll.set(max_scroll)` fires unconditionally every frame (live_transcript.rs:556–558) — the view jerks down with no ease. Thinking blocks toggle collapsed/expanded via a boolean (history/thinking.rs:84), snapping between fixed line limits (4/6/8 lines, history/thinking.rs:20–22) with no height interpolation. On `flush_active_cell` (app.rs:3857–3912) the finalized cells are appended with no height reservation, so the transcript grows under the reader. Sidebar panels appear/disappear by recomputing `Layout::split()` constraints every frame from boolean predicates (`auto_sidebar_panels`, sidebar.rs:219–237; `sidebar_auto_idle`, sidebar.rs:195–201) — width and panel count snap with zero intermediate frames.

- **Transients with no lifecycle.** `StatusToast` (app.rs:482–487) is `{ text, level, created_at, ttl_ms }` — no phase field. `active_status_toast()` (app.rs:4165–4195) hard-drops a toast the instant `is_expired()` (app.rs:501–504) is true; the footer renders it at full opacity with no fade (footer_ui.rs / widgets/footer.rs:560–572). There is no *minimum* display floor, so an error that clears in <100ms can flash and vanish before the eye registers it. Retry banners (`retry_status.rs:22–49`, footer.rs:582–601) are identical: a bare `Idle→Active→Idle` enum toggle with no phase and no dwell. Receipts (8s, app.rs:3978), version hints (12s, ui.rs:190), and file-mention candidates (4s, file_mention.rs:246) all vanish the same instant their TTL trips.

- **Scattered magic durations.** The 40+ constants above live in ~30 files with no `motion` module and **no easing functions anywhere in the codebase**. Values span 5ms to 12,000ms — a ~2400× spread — with no tokenized fast/base/slow. Even the two intentionally-decoupled cadences (120fps render cap vs. 80ms spinner) are undocumented as to *why* they differ, so future contributors will keep inventing new magic numbers.

- **Resize/focus flash.** On resize and on focus-regain the code calls `draw_app_frame_inner(full_repaint = true)`, which unconditionally issues `terminal.clear()` (ui.rs:9547–9550) — an `ESC[2J` that blanks the whole viewport before ratatui repaints. This is a literal black flash, and on a fast drag it fires repeatedly. On top of the flash, the full transcript per-cell cache is cleared synchronously on any width change (transcript.rs:163–167), re-wrapping every cell on the render thread — the sluggish re-flow the user feels while dragging.

The through-line: **the codebase has all the *state* for these surfaces and none of the *time*.** Add time, and the ugliness has somewhere to go.

---

## 3. The foundational fix — an animation clock + a `motion::timing` token module

Everything in Section 4 depends on this. Build it first.

### 3.1 The animation clock / scheduler

**Goal:** while anything is animating, the loop ticks at a steady 30–60fps; when nothing is animating, it idles exactly as it does today (zero cost when the UI is at rest — this must not become a busy-loop).

Concrete shape:

```rust
// crates/tui/src/tui/motion/clock.rs
pub struct AnimationClock {
    started: Instant,          // fixed origin; all progress is measured from here
    active: Vec<AnimationHandle>, // in-flight transitions
}

impl AnimationClock {
    pub fn now_ms(&self) -> u128 { self.started.elapsed().as_millis() }
    pub fn is_animating(&self) -> bool { !self.active.is_empty() }
    /// Next instant the loop MUST wake to advance an animation, if any.
    pub fn next_deadline(&self, now: Instant) -> Option<Instant> { /* now + tick */ }
    pub fn retire_completed(&mut self, now_ms: u128) { /* drop finished */ }
}
```

Integration points (all already exist, all one-line hooks):

- **Wake the loop.** In the `poll_timeout` computation in `ui.rs` (the block near ui.rs:3506–3537 that already shortens the timeout for `is_loading`, `stream_display_clock`, etc.), fold in `min(poll_timeout, clock.next_deadline())`. When any animation is in flight, the loop now wakes at the next frame boundary even with zero user input. This is the whole trick — it converts "sleep until an event" into "sleep until the next animation frame *or* an event, whichever is sooner."
- **Advance and request redraw.** After the frame limiter's `mark_emitted`, if `clock.is_animating()` set `needs_redraw = true` for the following frame. When the last animation retires, stop forcing — idle returns.
- **Read progress in render.** Give render access to `clock.now_ms()`. Each animated surface computes its own `progress = ((now_ms - started_ms) / duration_ms).clamp(0.0, 1.0)` and passes it through easing. Because every surface samples the *same* `now_ms`, all motion is in lockstep by construction — this alone fixes the spinner-vs-footer beat problem.

Tick rate: **30–50ms (20–33fps) is enough for terminal motion** and stays comfortably inside the existing 120fps limiter and the 30fps low-motion cap (frame_rate_limiter.rs:36, LOW_MOTION at 33.33ms). Honor `low_motion`: when set, either skip enter/exit easing (snap, but still respect min-visible-time) or run at the 30fps cap. Motion must be a comfort, never a tax.

Effort: **large**, but it is the *only* large item that unlocks a dozen medium/small ones. Treat it as the platform.

### 3.2 `motion::timing` — one tokenized scale + one easing set

Create `crates/tui/src/tui/motion/timing.rs` and make it the single source of truth. Suggested values (tuned for a terminal, where a few discrete frames already read as "smooth"):

```rust
// Durations — the fast/base/slow spine.
pub const INSTANT: Duration = Duration::ZERO;
pub const FAST:    Duration = Duration::from_millis(120); // snappy feedback, context menus
pub const BASE:    Duration = Duration::from_millis(200); // standard overlay enter
pub const SLOW:    Duration = Duration::from_millis(320); // deliberate / weighty (approval)

// Enter/exit — exits are a touch quicker than enters (leave decisively).
pub const OVERLAY_ENTER: Duration = BASE;                 // 200ms
pub const OVERLAY_EXIT:  Duration = Duration::from_millis(150);

// Spinner discipline.
pub const SPINNER_FRAME:      Duration = Duration::from_millis(80);  // keep existing cadence
pub const SPINNER_SHOW_DELAY: Duration = Duration::from_millis(150); // suppress instant ops
pub const SPINNER_MIN_SHOW:   Duration = Duration::from_millis(450); // never flicker

// Transient dwell (min-visible floors + fades).
pub const TRANSIENT_MIN_VISIBLE: Duration = Duration::from_millis(350);
pub const TOAST_FADE:            Duration = FAST; // 120ms in and out
```

```rust
// crates/tui/src/tui/motion/easing.rs — the entire easing vocabulary.
pub fn linear(t: f32) -> f32 { t }
pub fn ease_out_cubic(t: f32) -> f32 { 1.0 - (1.0 - t).powi(3) } // enters: fast then settle
pub fn ease_in_cubic(t: f32)  -> f32 { t * t * t }              // exits: withdraw decisively
pub fn step_half(t: f32) -> f32 { if t < 0.5 { 1.0 } else { 0.0 } } // cursor blink
```

Rule of thumb: **enter = `ease_out_cubic` (arrives eagerly, settles gently); exit = `ease_in_cubic` (accelerates away).** Symmetry with a slightly quicker exit is what reads as "elegant" rather than "sluggish."

Then **route the existing magic numbers through this module.** `BRAILLE_SPINNER_FRAME_MS` (spinner.rs:15) becomes `SPINNER_FRAME`. The toast TTLs in `classify_status_text` (app.rs:4038–4080) become named dwell tokens. The forced-repaint cadence `UI_STATUS_ANIMATION_MS` (ui.rs:184) references `SPINNER_FRAME` and gets a doc comment explaining the intentional 120fps-cap / 80ms-cadence decoupling (this last one is a *trivial* documentation fix worth doing regardless). One module, imported everywhere, kills the "2400× spread of unrelated numbers" problem and gives every future contributor a vocabulary instead of a fresh literal.

---

## 4. Per-surface transitions

Once 3.1 and 3.2 land, apply this table uniformly. Durations reference the Section 3.2 tokens. "Enter" and "exit" are the transition; "delay/min" is the discipline that prevents flicker. Everything uses `ease_out_cubic` on enter and `ease_in_cubic` on exit unless noted.

| Surface | Enter | Exit | Delay / Min-visible | Notes & anchor |
|---|---|---|---|---|
| **Command palette / model / provider / session / file picker / slash menu / feedback / pager / backtrack / context inspector** | `BASE` 200ms: alpha 0→1 + slide-down 3–5 rows→0 | `OVERLAY_EXIT` 150ms: reverse | Min-visible `TRANSIENT_MIN_VISIBLE` 350ms (guard `pop()` in `apply_action`) | Add `entering_at`/`exit_progress` to each `ModalView`; `push` records enter, `Close` sets exit instead of removing (views/mod.rs:795, 876) |
| **Approval modal** | `SLOW` 320ms: alpha 0→1 + slide-up 3 rows, backdrop dim 0→70% in lockstep | `OVERLAY_EXIT` 150ms | Min-visible **400–500ms** (reuse `requested_at`; block pop until elapsed) | Weightiest surface — earn the extra 120ms. Pushed ui.rs:10410, popped approval.rs:1405 |
| **Modal backdrop** | Alpha 0→70% over enter, synced to modal | 70%→0 over exit | — | Parameterize `render_modal_backdrop` (views/mod.rs:94–102) with `opacity: f32` |
| **Context menu** | `FAST` 120ms: scale 0.9→1.0 centered on cursor + alpha | `FAST` 120ms | — | Lightweight; punchy is correct. Scale origin = `(column, row)` (context_menu.rs:34–44) |
| **Running spinners (tool cards, footer strip, sidebar tasks)** | Appear only after `SPINNER_SHOW_DELAY` 150ms | Hold to `SPINNER_MIN_SHOW` 450ms after first frame, then a 200ms completion glyph (✓/•) before hiding | Delay 150ms, min-show 450ms | Wrap in a `SpinnerDisplay` that tracks `first_shown_at`; gate `braille_spinner_frame` calls in history.rs:1710, footer_ui.rs:258, sidebar.rs:1680 |
| **Spinner cadence** | — | — | Fixed `SPINNER_FRAME` 80ms sampled from `clock.now_ms()` | Replace independent wall-clock samples (footer_ui.rs:267, sidebar.rs:1683) with the shared clock so all spinners lockstep |
| **Streaming reveal** | Paced ~2–4 chars/frame Smooth, ~8–15 CatchUp, `linear` | — | — | Add a per-frame reveal budget in `commit_tick.rs` (currently all-or-one, commit_tick.rs:154–157); optionally a `reveal_cursor`. Requires the clock to tick between SSE chunks |
| **Streaming cursor** | — | — | Blink `step_half`, 600ms period, start after 50ms | Time-modulate `REASONING_CURSOR` (history/thinking.rs:174–176) using `clock.now_ms()` — mirror the pattern already in streaming_thinking.rs:105–119 |
| **Thinking block collapse/expand** | Height lerp prev→target, `ease_out_cubic` | Same, symmetric | `BASE`–`SLOW` 200–280ms | Interpolate line count in `render_thinking` (history/thinking.rs:79–166) instead of snapping between fixed limits |
| **New transcript cell** | Height grow 30%→60%→100% over 3–4 frames, or fade-in over `FAST` | — | — | Stage in `flatten_from` (transcript.rs:282–299); cheapest correct version is a 3-frame height ramp keyed off a per-cell `entered_at` |
| **Scroll-to-bottom (sticky)** | Ease scroll last→target `ease_out_cubic` 150–200ms | — | — | Replace unconditional `scroll.set(max_scroll)` (live_transcript.rs:556–558) with an interpolated target |
| **Status toasts** | `TOAST_FADE` 120ms fade+slide-up 0.5 row | `TOAST_FADE` 120ms fade+slide-down | Min-visible `TRANSIENT_MIN_VISIBLE` 350ms; optional 80–120ms entry delay for errors so <100ms hiccups never show | Add `phase` + `phase_started_at` to `StatusToast` (app.rs:482–487); `is_expired` becomes `elapsed > ttl + fade` |
| **Retry banner** | `FAST` 120ms fade+scale 0.9→1 | `FAST` 120ms | Min-visible **400ms** (so instant-success retries are still seen) | Same phase pattern on `RetryState`/`RetryBanner` (retry_status.rs:22–49) |
| **Receipts / version hint / file candidates** | fade-in `FAST` | fade-out `FAST` 150ms | Keep existing TTLs (retokenized) | Add `exit_started` (app.rs:3978, ui.rs:190, file_mention.rs:246); remove only after fade completes |
| **Sidebar width (collapse/expand)** | Width lerp current→target `ease_out_cubic` 200ms | Same | — | Animate the `Constraint` percentage instead of flipping `sidebar_auto_idle` (sidebar.rs:195) into an instant `Layout::split` |
| **Sidebar panels (todo/tasks/agents/context)** | fade+height-clip in, `BASE` 150ms | 120ms; keep exiting panel alive until fade done | — | Diff `auto_sidebar_panels` (sidebar.rs:219–237) frame-over-frame; record enter/exit per panel |
| **Subagent rows** | per-row fade `FAST` with +50ms stagger between rows | 100ms | — | Add `entered_at`/`exited_at` to `SidebarAgentRow` (sidebar.rs:2488–2501); keep evicted rows alive one fade |
| **Completed task row (8s TTL)** | — | 150ms fade before drop | Hold ≥400ms after completion before fade starts | `active_tool_row_visibility` (sidebar.rs:1728–1752) currently binary at TTL |
| **Resize** | No fade — *eliminate the flash* (Section 5A) | — | Debounce rapid drags 150–200ms into one draw | Replace unconditional `terminal.clear()` (ui.rs:9547–9550) with selective/diff repaint |
| **Focus change (region → region)** | Cross-fade focus indicator old→new `FAST` 150ms | — | — | `set_sidebar_focus` currently mutates the enum + `needs_redraw` with no transition |

---

## 5. Ranked recommendations

Two buckets. **Bucket A ships value *before* the clock exists** — do these first; they kill the worst flashes and are all small/medium. **Bucket B is the motion system** — the clock, the tokens, and the per-surface transitions that give the UI its polish.

### Bucket A — quick wins, no animation clock required

Ordered by impact-per-effort.

1. **Eliminate the full-terminal-clear flash on resize & focus.**
   - *Symptom fixed:* the whole viewport blanks black on every resize and every app-switch-back; repeats on a fast drag.
   - *Change:* stop calling `terminal.clear()` unconditionally when `full_repaint` is true (ui.rs:9547–9550). On focus-regain, rely on `needs_redraw` + ratatui's diff (a debounce path already exists near ui.rs:3637). On resize, only clear when the viewport *grew*; for shrink/same-size let the diff renderer handle it. Add a 150–200ms resize debounce (ui.rs:3655–3728) so a drag coalesces into one draw.
   - *Effort:* medium. Highest visible payoff of any single change.

2. **Spinner show-delay + min-visible-time.**
   - *Symptom fixed:* sub-100ms ops flash a spinner glyph (looks like a glitch); the strip pops out before the eye registers it.
   - *Change:* introduce a `SpinnerDisplay { first_shown_at }` wrapper. Don't render the glyph until `SPINNER_SHOW_DELAY` (150ms) has elapsed; once shown, keep it for `SPINNER_MIN_SHOW` (450ms) even if the op finished, then a brief completion marker. Gate the call sites at history.rs:1710, footer_ui.rs:258, sidebar.rs:1680. *No clock needed* — these are wall-clock comparisons in the existing render path.
   - *Effort:* small–medium.

3. **Unify spinner cadence.**
   - *Symptom fixed:* footer working-strip (`now_ms/400`) beats against the 80ms braille spinner and sidebar spinners.
   - *Change:* pick `SPINNER_FRAME` (80ms) as the one cadence; drive every spinner from a single `app.animation_frame` (a `u64` bumped once per redraw) instead of independent wall-clock reads (footer_ui.rs:267, sidebar.rs:1683). Interim step before the real clock; the clock later subsumes it.
   - *Effort:* small.

4. **Minimum-dwell + entry-suppression for toasts and retry banners.**
   - *Symptom fixed:* a network error that clears in <100ms flashes and vanishes unseen; a fast-success retry banner never registers.
   - *Change:* track `shown_at` + `min_display_duration` (350–400ms) on `StatusToast` (app.rs:482–487) and `RetryState`; refuse expiry until the floor passes regardless of TTL. For error/warning toasts, add an 80–120ms pending window so ultra-fast recoveries are discarded before they ever show (push logic at app.rs:3922). Also retokenize the TTLs (app.rs:4038–4080) through `motion::timing`.
   - *Effort:* small.

5. **Scroll anchoring on resize (no new flash, less disorientation).**
   - *Symptom fixed:* content appears to "jump" on resize even though scroll position is technically preserved (app.rs:4210–4216) — no visual bridge.
   - *Change:* keep the anchor line centered (±3 rows) rather than pinned to top, so the reader's eye tracks it across a re-wrap. A brief 200–300ms highlight on the anchored line is a nice-to-have but can wait for the clock.
   - *Effort:* small.

6. **Defer the transcript width-cache invalidation by one frame.**
   - *Symptom fixed:* perceptible stutter while dragging to a new width, as every markdown cell re-wraps synchronously on the render thread.
   - *Change:* on width change, draw once at the old width, then invalidate `per_cell` (transcript.rs:163–167) on the next loop iteration so the debounce and scroll anchoring coordinate — or move markdown re-wrap off the render thread.
   - *Effort:* medium.

7. **Document the 120fps-cap / 80ms-spinner decoupling.**
   - *Symptom fixed:* future contributors keep inventing magic numbers because the existing ones aren't explained.
   - *Change:* comment `frame_rate_limiter.rs:36`, `ui.rs:184`, and `spinner.rs:15` to state that the render cap prevents SSE-driven waste while the spinner cadence is the *perceptual* motion rate, and that they are intentionally independent layers.
   - *Effort:* trivial.

### Bucket B — the motion system

8. **Build the `AnimationClock` scheduler (Section 3.1).**
   - *Symptom fixed:* the root cause — nothing can ease over time, spinners stall when idle, streaming can't reveal between chunks.
   - *Change:* steady 30–50fps tick while animating, idle otherwise; fold `next_deadline()` into the `poll_timeout` calc (ui.rs:3506–3537); expose `now_ms()` to render. Honor `low_motion`.
   - *Effort:* large. The keystone.

9. **Add `motion::timing` + `motion::easing` and route the 40+ magic numbers through them (Section 3.2).**
   - *Symptom fixed:* "nothing feels coordinated" — one fast/base/slow scale and one easing set replace the 2400× spread.
   - *Effort:* large (mechanical breadth, low risk). Land alongside #8.

10. **Overlay & modal enter/exit + backdrop fade.**
    - *Symptom fixed:* every picker/palette/menu and the approval modal snap in and out; backdrop hard-cuts.
    - *Change:* `entering_at`/`exit_progress`/`opened_at` on each `ModalView`; `push` schedules enter, `Close` schedules exit and defers `pop()` until the exit completes (views/mod.rs:795, 876); `render_modal_surface`/`render_modal_backdrop` (views/mod.rs:64–102) take alpha/scale/offset. Enforce min-visible in `apply_action`.
    - *Effort:* medium (per-surface, but one shared pattern).

11. **Streaming reveal pacing + cursor blink.**
    - *Symptom fixed:* text arrives in bursty batches; the caret is static.
    - *Change:* per-frame char budget in `commit_tick.rs` (replace all-or-one at commit_tick.rs:154–157); blink `REASONING_CURSOR` off `clock.now_ms()` (history/thinking.rs:174–176). Requires the clock to tick between SSE chunks.
    - *Effort:* medium.

12. **Transcript cell grow-in, sticky-scroll easing, thinking-block height animation.**
    - *Symptom fixed:* content shoves the transcript, sticky-scroll jerks, folds snap.
    - *Change:* staged height in `flatten_from` (transcript.rs:282–299); interpolated `scroll.set` target (live_transcript.rs:556–558); height-lerp in `render_thinking` (history/thinking.rs:79–166).
    - *Effort:* large (transcript is the hottest, most cache-sensitive path — sequence carefully).

13. **Sidebar width/panel/row transitions + focus cross-fade.**
    - *Symptom fixed:* sidebar collapse, panel appear/disappear, and subagent rows all pop; focus jumps with no bridge.
    - *Change:* animate the width `Constraint` (sidebar.rs:195); diff panels/rows frame-over-frame with per-item enter/exit (sidebar.rs:219–237, 2488–2501); fade completed-task rows before drop (sidebar.rs:1728–1752); cross-fade focus indicator.
    - *Effort:* medium–large.

---

## 6. Prioritized checklist

Do them in this order. A–1 through A–7 are safe to ship independently and immediately; they remove the loudest complaints. B–8 and B–9 are the platform and should land together. B–10 onward are pure payoff once the platform exists.

- [ ] **A–1. Kill the full-terminal-clear flash on resize + focus; debounce rapid resizes.** *(medium — biggest single visible win)* — ui.rs:9547–9550, ui.rs:3655–3728, ui.rs:3637
- [ ] **A–2. Spinner show-delay (150ms) + min-visible-time (450ms) + completion marker.** *(small–medium)* — history.rs:1710, footer_ui.rs:258, sidebar.rs:1680
- [ ] **A–3. Unify all spinners to one 80ms cadence via a shared `animation_frame` counter.** *(small)* — footer_ui.rs:267, sidebar.rs:1683, spinner.rs:15
- [ ] **A–4. Min-dwell (350–400ms) + fast-error entry-suppression on toasts & retry banners; retokenize TTLs.** *(small)* — app.rs:482–487, 3922, 4038–4080, retry_status.rs:22–49
- [ ] **A–5. Center-anchor scroll on resize (±3 rows) so content doesn't appear to jump.** *(small)* — app.rs:4210–4216
- [ ] **A–6. Defer transcript width-cache invalidation one frame (or move re-wrap off the render thread).** *(medium)* — transcript.rs:163–167
- [ ] **A–7. Document the 120fps-cap / 80ms-spinner decoupling.** *(trivial)* — frame_rate_limiter.rs:36, ui.rs:184, spinner.rs:15
- [ ] **B–8. Build `AnimationClock` — steady 30–50fps while animating, idle otherwise; wire into `poll_timeout`; honor low-motion.** *(large — keystone)* — new `motion/clock.rs`, ui.rs:3506–3537
- [ ] **B–9. Create `motion::timing` + `motion::easing`; route the 40+ magic durations through them.** *(large, mechanical)* — new `motion/timing.rs`, `motion/easing.rs`
- [ ] **B–10. Overlay/modal enter+exit + backdrop fade + enforced min-visible (all pickers, palette, menus, approval).** *(medium)* — views/mod.rs:64–102, 795, 876; approval.rs:1329–1354, 1405
- [ ] **B–11. Streaming reveal pacing (per-frame char budget) + cursor blink.** *(medium)* — commit_tick.rs:154–157, history/thinking.rs:174–176
- [ ] **B–12. Transcript cell grow-in + sticky-scroll easing + thinking-block height animation.** *(large — hot path, sequence carefully)* — transcript.rs:282–299, live_transcript.rs:556–558, history/thinking.rs:79–166
- [ ] **B–13. Sidebar width/panel/row transitions + focus cross-fade.** *(medium–large)* — sidebar.rs:195, 219–237, 1728–1752, 2488–2501

The test for "done" is simple and human: open a picker, approve a tool, watch a short tool run, resize the window, and let a response stream — and none of it should *pop*. It should arrive, and it should leave the way it arrived.
