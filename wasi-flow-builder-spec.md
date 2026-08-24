# Wasi — Visual Flow Builder Specification

**Goal:** a drag-and-drop flow builder matching the interaction quality of AiSensy and n8n. Not a read-only diagram — a canvas where flows are created, connected, configured, and edited without leaving it.

**Current state:** the flow engine is complete and verified in production — flows, nodes, edges, per-contact state, CAS advance, delays, timeouts, validator, edge priority. A read-only Drawflow canvas exists (`3d1321a`). Editing happens in a step-list form.

**What this replaces:** the step-list editor becomes secondary or is removed. The canvas becomes the primary way flows are built.

---

## Non-negotiables

These are constraints, not preferences. A plan that violates them is the wrong plan.

**The backend does not change.** `automation_flows`, `flow_nodes`, `flow_edges`, `contact_flow_state`, `flow_events` are built, tested, and running in production with a real client's flows in them. `flow_nodes.position` already exists for exactly this purpose. Any proposal requiring schema changes must justify them specifically.

**The validator must be visible on the canvas.** A spike proved a graph alone hides an unrouted button — a real bug in a real flow that the step list caught and the canvas didn't. Any node with an issue must show it on the node itself, not only in a banner.

**Edge condition types must be visually distinct.** One `send_interactive_buttons` node can have up to six outgoing edges: three button branches, keyword, default, and timeout. Investigation found neither AiSensy nor ManyChat documents a clean solution to this. It is the hardest visual problem in this build and must be solved explicitly, not assumed.

**No silent data loss.** A client editing a live flow must never lose work to a failed save, a stale view, or a concurrent edit.

---

## What "like AiSensy and n8n" actually means

Break this into the specific interactions, because "like AiSensy" is not implementable as written.

### Node creation
- A palette of node types, visible on the canvas
- Drag a node type onto the canvas to create it at that position
- Or: drag from a node's output port onto empty canvas to create and connect in one gesture (n8n does this; it is the single biggest speed difference)

### Connection
- Drag from an output port to another node's input port
- Visual feedback while dragging — the line follows the cursor, valid targets highlight
- Invalid connections rejected with a reason, not silently ignored
- Click an edge to select it; delete key or a control removes it

### Configuration
- Click a node to open its config — inline panel or side drawer, not a modal that hides the canvas
- Changes reflect on the node immediately (a `send_text` node shows its message preview)

### Canvas navigation
- Pan by dragging background, zoom by scroll
- Fit-to-view control
- Auto-layout for flows created before positions existed

### Persistence
- Node positions save on drag-end, debounced
- Explicit save for config changes, or autosave with clear state indication
- The client must always know whether their work is saved

---

## Investigation required before building

Assign these as parallel read-only agents. All report before any implementation.

### Agent 1 — Library evaluation, decisively

A previous investigation identified Drawflow as the only no-build-step option that fits, and it is already integrated in read-only mode. That was for *viewing*. This is for *editing*, which is a different question.

- Does Drawflow's editing mode actually support: drag-from-palette, drag-from-port-to-create, edge deletion, multi-output ports with labels?
- Where does Drawflow fall short of n8n's interaction quality specifically? Be concrete.
- What is the honest cost of introducing a build step — Vite or esbuild — and using a React-based library like React Flow instead? This codebase deliberately has no build step, but "deliberately" was a decision made when the app was simpler.
- Report three paths with real effort estimates: extend Drawflow, hand-roll on top of it, or introduce a build step.

**This is the decision everything else depends on. Do not hedge it.**

### Agent 2 — The six-edge problem

The hardest visual problem in this build.

- How should six outgoing edges from one node be laid out so they are readable?
- Separate output ports per edge, or one port with labelled edges?
- What happens visually when three of the six point at the same target node?
- How do button branches stay visually associated with the button they represent when the button title is edited?
- Study how n8n handles Switch nodes and how Typebot handles button blocks — both solve a version of this.

Report a specific visual design, not options.

### Agent 3 — Editing safety

A client will edit a flow that has contacts currently sitting mid-execution in it.

- What happens to a contact at node X when node X is deleted?
- What happens when an edge they are about to traverse is removed?
- Does `contact_flow_state` need a version or flow-snapshot concept?
- Should editing an active flow be blocked, or should edits apply only to new executions?
- What does AiSensy do here? What does ManyChat do?

This has not been considered anywhere in the current implementation and it is a genuine data-integrity question.

### Agent 4 — Interaction detail, from real products

Not features — mechanics. Report at the level of "drag from the right-hand port; the line snaps to the nearest valid input within 40px."

- n8n: node creation, connection, deletion, the plus-button-on-edge pattern
- AiSensy: same
- Typebot: same — it is open source, so the implementation can be read rather than inferred
- What keyboard shortcuts exist? Undo/redo?
- What happens on a narrow screen?

### Agent 5 — Migration and coexistence

- Existing flows have no positions. What layout algorithm runs on first open?
- Does the step-list editor stay as an alternative view, or get removed?
- If both stay, how do they stay consistent?
- What happens to a flow edited in the canvas by one person while open in the list for another?

---

## Staged delivery

Do not attempt this in one pass. Each stage must be usable and shippable on its own.

| Stage | Scope | Gate |
|---|---|---|
| 1 | Library decision and a working spike: create a node, connect two nodes, save positions | Prove the chosen library handles editing before committing weeks to it |
| 2 | Node palette, drag-to-create, drag-to-connect, edge deletion | The core interaction loop |
| 3 | Six-edge layout, condition-type visual distinction, validator warnings on nodes | The hard visual problem |
| 4 | Inline node configuration | Editing without leaving the canvas |
| 5 | Persistence, autosave state, concurrent-edit handling | Data safety |
| 6 | Auto-layout for existing flows, migration from step editor | Existing flows work |
| 7 | Live verification: build a real flow entirely on the canvas, run it end to end from a real phone | Proof it works, not just that it renders |

**Stage 1 is a hard gate.** If the chosen library cannot handle editing cleanly, the answer changes and it is far cheaper to find out in a day than in week three.

---

## Verification standard

Every stage ends with the flow actually running, not just rendering. The engine is real — a flow built on the canvas must start from a keyword, branch on a button tap from a real phone, fire a timeout, and complete.

Stage 7 is not optional. Every serious bug in this project surfaced from running code, not reading it: the button payload shape, the broadcast parameter gap, the webhook dispatch bug, the pool crash, the unrouted button. None were visible by inspection.

---

## Honest cost

Prior investigation estimated 2–4 weeks for a full editor, with real risk of longer, and noted that neither AiSensy nor ManyChat has publicly solved the six-edge problem cleanly.

The read-only canvas took a few hours. That ratio is the warning: viewing is easy, editing is not.

**Before starting, weigh this against the alternative.** The step-list editor builds working flows today — the Stage 7 flow ran end to end from a real phone. Four clients are waiting to be onboarded. Three to four weeks on a builder is three to four weeks not spent on them.

If the builder is what the business needs, build it properly. If it is wanted because competitors have one, onboard the clients first and let their actual complaints decide.
