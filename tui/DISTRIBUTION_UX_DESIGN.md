# TUI-Native Distribution UX Design

## Overview
This document specifies the design for intuitive multi-process distribution controls in the opensmi TUI. The goal is to provide Slurm-like multi-node/multi-GPU deployment capabilities through a simple, visual TUI interface without complex configuration files.

## Current State (Iteration 2)

### Existing Distribution Features
The command runner already has two distribution modes:

1. **single**: One command across N GPUs
   - Example: `CUDA_VISIBLE_DEVICES=0,1,2 python train.py`
   - Use case: Single-process multi-GPU training

2. **one-to-one**: Different command per GPU
   - Example: 
     ```
     GPU0: python train.py --fold 0
     GPU1: python train.py --fold 1
     GPU2: python train.py --fold 2
     ```
   - Use case: Parallel cross-validation, hyperparameter sweeps

### Current Limitations
- No direct GPU assignment UI (selection is auto-ranked or manual click)
- GPU selection spread across dashboard clicks (not centralized)
- No visual feedback showing which process goes to which GPU
- Distribution configuration requires understanding modes and shortcuts

## Phase 3 Goals

### 1. Centralized GPU Assignment Panel
Add a visual GPU assignment section to the runner pane that shows:
- Which GPUs are selected
- Which command maps to which GPU (in one-to-one mode)
- Real-time preflight status per GPU (idle/busy, allocated, reasoning)

### 2. Direct GPU Controls
Enable users to:
- Click GPUs to toggle selection from within the runner pane
- Drag-and-drop to reorder GPU assignments (stretch goal)
- See immediate feedback when GPU selection changes
- Understand why each GPU was selected (reasoning)

### 3. Distribution Workflow UX

#### Current Flow (needs improvement):
1. Open runner (`l` or `ctrl+x ↓`)
2. Type command
3. Press `+`/`-` to adjust GPU count
4. Toggle modes with `Tab` / `Shift+Tab`
5. Click GPUs in dashboard to manually select (interrupts typing)
6. Execute

#### Improved Flow:
1. Open runner (`l` or `ctrl+x ↓`)
2. Type command(s)
3. GPU Assignment Panel shows:
   - Auto-selected GPUs with reasoning
   - Ability to click GPUs in the panel to toggle
   - Visual mapping: Command N → GPU N
4. Adjust count/mode with `+`/`-` / `Tab` / `Shift+Tab`
5. Execute with visual confirmation of what will run where

## UI Layout Design

### Runner Pane Layout (Expanded View)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ▾ Command Runner  ● focused                  [ctrl+x f] Fold  [Esc] Close │
├────────────────────────────────────────────────────────────────────────────┤
│ Exec: tmux  Dist: one-to-one  Count: 3  GPU: Auto [g]  [Tab] Mode         │
├────────────────────────────────────────────────────────────────────────────┤
│ Commands                                                                   │
│ [1] ▸ python train.py --fold 0                                            │
│ [2]   python train.py --fold 1                                            │
│ [3]   python train.py --fold 2                                            │
├────────────────────────────────────────────────────────────────────────────┤
│ GPU Assignment                          [click to toggle]  [+/-] adjust   │
│ ┌────────────────────────────────────────────────────────────────────────┐│
│ │ [1] ● node-01:GPU0  [alice]  24G free  idle 2h  ✓ never used         ││
│ │ [2] ● node-01:GPU1  [alice]  24G free  idle 5m  ✓ low utilization    ││
│ │ [3] ● node-02:GPU0  [alice]  20G free  idle 1h  ✓ fewer processes    ││
│ └────────────────────────────────────────────────────────────────────────┘│
├────────────────────────────────────────────────────────────────────────────┤
│ Preflight Checks                                                           │
│ ✓ tmux installed          ✓ commands valid          ✓ 3 GPUs available   │
├────────────────────────────────────────────────────────────────────────────┤
│ State: READY                                                               │
│ [ctrl+x Enter] Execute  [Esc] Unfocus  [g] Toggle GPU Mode                │
└────────────────────────────────────────────────────────────────────────────┘
```

### GPU Assignment Panel Details

**Auto Mode** (default):
```
GPU Assignment  (Auto-ranked)              [click to exclude]  [g] manual
┌──────────────────────────────────────────────────────────────────────────┐
│ [1] ● node-01:GPU0  [alice]  24G free  idle 2h  ✓ never used           │
│ [2] ● node-01:GPU1  [alice]  24G free  idle 5m  ✓ low utilization      │
│ [3] ○ node-02:GPU0  [bob]    20G free  active   ✗ allocated to bob     │
│     (click ○ to include, ● to exclude)                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

**Selected Mode** (user picks):
```
GPU Assignment  (Manual selection)         [click to toggle]  [g] auto
┌──────────────────────────────────────────────────────────────────────────┐
│ [1] ● node-01:GPU0  [alice]  24G free  idle 2h                          │
│ [2] ● node-01:GPU1  [alice]  24G free  idle 5m                          │
│ [3]                                                                      │
│     ▸ Click GPUs in dashboard or this panel to select                   │
└──────────────────────────────────────────────────────────────────────────┘
```

**One-to-One Mapping** (when `launchDistMode === "one-to-one"`):
```
GPU Assignment & Command Mapping                      [+/-] adjust count
┌──────────────────────────────────────────────────────────────────────────┐
│ Command 1 → [1] ● node-01:GPU0  [alice]  24G  idle 2h  (never used)    │
│ Command 2 → [2] ● node-01:GPU1  [alice]  24G  idle 5m  (low util)      │
│ Command 3 → [3] ● node-02:GPU0  [alice]  20G  idle 1h  (few procs)     │
└──────────────────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Task 1: Design intuitive multi-process distribution UI ✓ (Current)

**Deliverables:**
- [x] Analyze current distribution system
- [x] Design GPU Assignment Panel layout
- [x] Design interaction patterns (click to toggle, visual feedback)
- [x] Define state management for GPU assignments
- [x] Document UX flow improvements

**Success Criteria:**
- Design document complete with:
  - UI mockups for all modes (single/one-to-one, auto/manual)
  - Interaction patterns specified
  - Integration points with existing code identified
  - Clear acceptance criteria for implementation

### Task 2: Implement direct GPU assignment controls in TUI

**Subtasks:**
1. Create `renderGpuAssignmentPanel()` function
2. Add click handlers for GPU selection within panel
3. Implement visual indicators (●/○, colors, reasoning text)
4. Integrate with existing `launchSelectedGpus` state
5. Handle mode switching (auto ↔ selected)

**Integration Points:**
- State: `launchSelectedGpus`, `launchManualGpus`, `launchGpuMode`
- Functions: `refreshLaunchGpuSelection()`, `getGpuLabel()`
- Rendering: Insert panel between Commands and Preflight sections

### Task 3: Add visual feedback for distribution configuration

**Visual Feedback Elements:**
1. **GPU Status Indicators**
   - `●` Selected
   - `○` Available but not selected
   - `✓` Passing preflight check
   - `✗` Failing preflight check
   - Color coding: green (good), yellow (warning), red (error)

2. **Reasoning Display**
   - Show why each GPU was selected (auto mode)
   - Show allocation conflicts
   - Show resource availability

3. **Command-GPU Mapping** (one-to-one mode)
   - Visual line/arrow: "Command N → GPU N"
   - Highlight active command-GPU pair
   - Show which command will run on which GPU

### Task 4: Integrate distribution controls into "My GPU View"

**My GPU View Integration:**
- When opening runner from My GPU View:
  - Auto-set `launchGpuMode = "selected"`
  - Pre-populate `launchManualGpus` with current bundle GPUs
  - Show "Bundle: My Allocated GPUs" in GPU Assignment Panel
- GPU Assignment Panel shows bundle context:
  ```
  GPU Assignment  (From bundle: My Allocated GPUs)
  ```

### Task 5: Test multi-process deployment workflow

**Test Scenarios:**
1. **Single-command multi-GPU** (existing, regression test)
   - 1 command, 3 GPUs, single mode
   - Verify: `CUDA_VISIBLE_DEVICES=0,1,2 <command>`

2. **One-to-one cross-validation** (existing, regression test)
   - 3 commands, 3 GPUs, one-to-one mode
   - Verify: 3 separate processes with correct GPU assignments

3. **Auto GPU selection with exclusions** (new)
   - Auto mode, click to exclude bad GPUs
   - Verify: Selected GPUs match user intent

4. **Manual GPU selection from panel** (new)
   - Selected mode, click GPUs in panel
   - Verify: Selection updates immediately, commands map correctly

5. **My GPU View → Runner workflow** (new)
   - Open runner from My GPU View
   - Verify: Bundle GPUs pre-selected, launchGpuMode = "selected"

## State Management

### New State Variables (if needed)
None required - existing state is sufficient:
- `launchSelectedGpus`: Final GPU list used for execution
- `launchManualGpus`: User-picked GPUs (in "selected" mode)
- `launchGpuMode`: "auto" or "selected"
- `launchDistMode`: "single" or "one-to-one"
- `launchNumGpus`: Target GPU count

### State Transitions
```
User opens runner
  ↓
launchGpuMode = "auto" (default)
launchNumGpus = 0
  ↓
User presses '+' to add GPUs
  ↓
refreshLaunchGpuSelection() called
  ↓ (if auto mode)
Python ranker selects top N GPUs → launchSelectedGpus
  ↓ (if selected mode)
launchManualGpus → launchSelectedGpus
  ↓
User clicks GPU in panel
  ↓ (in auto mode)
Exclude GPU from auto-selection, remain in auto mode
  ↓ (in selected mode)
Toggle GPU in launchManualGpus
  ↓
launchSelectedGpus updated
  ↓
Render GPU Assignment Panel with new state
```

## Interaction Patterns

### GPU Selection (Auto Mode)
1. Default: Auto-ranked GPUs shown with ●
2. Click ● GPU → Exclude from selection (becomes ○)
3. Click ○ GPU → Include in selection (becomes ●)
4. Excluded GPUs remembered during session
5. Press `g` → Switch to manual mode

### GPU Selection (Selected Mode)
1. Initially empty or pre-filled (from My GPU View)
2. Click ○ GPU → Add to selection (becomes ●)
3. Click ● GPU → Remove from selection (becomes ○)
4. Press `g` → Switch to auto mode

### Command Editing (One-to-One Mode)
1. Navigate commands with ↑/↓ or click
2. Press Enter to edit focused command
3. Editing updates command for that specific GPU
4. GPU Assignment Panel shows real-time mapping

### Execution Confirmation
1. Press `ctrl+x Enter` to execute
2. (Future) Show confirmation modal with final GPU assignments
3. Execute and show status per GPU

## Acceptance Criteria

### Task 1: Design ✓
- [x] Design document complete
- [x] UI mockups for all states
- [x] Integration points identified
- [x] No missing edge cases

### Task 2: Implementation
- [ ] GPU Assignment Panel renders correctly
- [ ] Click handlers work (toggle selection)
- [ ] Visual indicators update in real-time
- [ ] Mode switching (auto ↔ selected) works
- [ ] No regressions in existing runner functionality

### Task 3: Visual Feedback
- [ ] GPU status indicators visible (●/○/✓/✗)
- [ ] Reasoning text shows why GPU selected/excluded
- [ ] Command-GPU mapping clear (one-to-one mode)
- [ ] Color coding consistent with theme

### Task 4: My GPU View Integration
- [ ] Opening runner from My GPU View pre-selects bundle GPUs
- [ ] `launchGpuMode` set to "selected" automatically
- [ ] Bundle context shown in panel

### Task 5: Testing
- [ ] All test scenarios pass
- [ ] No regressions in existing workflows
- [ ] Multi-process deployment works end-to-end
- [ ] Error cases handled gracefully (no GPUs, allocation conflicts)

## Edge Cases

1. **No GPUs available**
   - Show: "No GPUs available. Try reducing count or freeing GPUs."
   - Disable execution

2. **Allocated GPUs in auto mode**
   - Show warning: "GPU allocated to other user"
   - Exclude from auto-selection by default
   - Allow manual override with click

3. **GPU count exceeds available**
   - Show: "Only N GPUs available (requested M)"
   - Clamp to available count
   - Show preflight failure

4. **Command count ≠ GPU count (one-to-one mode)**
   - If commands > GPUs: Show error, disable execution
   - If commands < GPUs: Pad with empty commands or show warning

5. **Mode switching with active selection**
   - Auto → Selected: Copy current launchSelectedGpus to launchManualGpus
   - Selected → Auto: Clear launchManualGpus, refresh auto-selection

## Future Enhancements (Post-Phase 3)

1. **Drag-and-drop GPU reordering**
   - Reorder GPU assignments in one-to-one mode
   - Visual feedback during drag

2. **GPU affinity templates**
   - Save common GPU configurations
   - Quick load: "My usual 4 GPUs on node-01"

3. **Real-time GPU status updates**
   - Show GPU utilization changes during selection
   - Highlight GPUs that become busy

4. **Multi-node visualization**
   - Group GPUs by node
   - Show node-level constraints (e.g., "avoid mixing nodes")

5. **Dry-run mode**
   - Preview exact commands that will execute
   - Show environment variables, CUDA_VISIBLE_DEVICES, etc.

## Notes for Implementation

- Keep runner pane height flexible (40% of terminal when unfolded)
- GPU Assignment Panel should scroll if many GPUs
- Click handlers must not interfere with text selection
- Use zIndex carefully to layer interactions
- Maintain performance with large GPU counts (100+ GPUs)
- Test on small terminals (80x24 minimum)
