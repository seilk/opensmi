# Multi-Process Distribution Workflow Testing

## Automated Tests

Run automated tests:
```bash
cd tui
bun test_distribution.ts
```

### Test Coverage

1. **GPU Ranker Logic** ✓
   - Validates that GPUs with active processes rank lower
   - Verifies tier-based priority ranking system
   - Tests idle time consideration

2. **Distribution Mode State** ✓
   - Confirms all state variables exist
   - Validates distribution mode types

3. **Single Mode Command Generation** ✓
   - Tests `CUDA_VISIBLE_DEVICES` formatting
   - Verifies single command with multiple GPUs

4. **One-to-One Mode Command Generation** ✓
   - Validates command-to-GPU mapping
   - Tests multi-command distribution

5. **GPU Selection Reasoning** ✓
   - Tests ranking produces expected results
   - Validates GPU tier assignment

6. **Launch History Integration** ✓
   - Tests saving and loading launch history
   - Verifies timestamp persistence

7. **Preflight Checks** ✓
   - Validates preflight check structure exists
   - Tests status tracking

8. **Tab System Integration** ✓
   - Confirms tab registry exists
   - Validates My GPU View tab registration

9. **My GPU View Bundle Selection** ✓
   - Tests bundle state management
   - Validates pinned GPUs mechanism

10. **Distribution Controls State** ✓
    - Tests mode toggle functionality
    - Validates GPU selection state management

## Manual Testing Scenarios

### Scenario 1: Single-Command Multi-GPU (Regression Test)

**Setup:**
- Have access to cluster with 3+ GPUs
- Start TUI: `bun index.ts`

**Steps:**
1. Press `l` to open command runner
2. Type: `python -c "import torch; print(torch.cuda.device_count())"`
3. Press `+` three times to select 3 GPUs
4. Verify mode shows: `Dist: one-to-one`
5. Press `Shift+Tab` to toggle to single mode
6. Verify mode shows: `Dist: single`
7. Press `Enter` to execute

**Expected Result:**
- Command executes as: `CUDA_VISIBLE_DEVICES=0,1,2 python -c "import torch; print(torch.cuda.device_count())"`
- Output shows: `3`

### Scenario 2: One-to-One Cross-Validation (Regression Test)

**Setup:**
- Have access to cluster with 3+ GPUs
- Start TUI: `bun index.ts`

**Steps:**
1. Press `l` to open command runner
2. Paste three commands (multiline):
   ```
   python train.py --fold 0
   python train.py --fold 1
   python train.py --fold 2
   ```
3. Press `+` until GPU count = 3
4. Verify mode shows: `Dist: one-to-one`
5. Verify GPU Assignment shows 3 GPUs with command mapping
6. Press `Enter` to execute

**Expected Result:**
- 3 separate processes launched, each with one GPU
- Command 1 maps to GPU 1, Command 2 to GPU 2, etc.
- Each process has correct `CUDA_VISIBLE_DEVICES` set

### Scenario 3: Auto GPU Selection

**Setup:**
- Have cluster with mixed GPU states (some busy, some idle)
- Start TUI: `bun index.ts`

**Steps:**
1. Press `l` to open command runner
2. Type any command
3. Press `+` to add 2 GPUs
4. Observe GPU Assignment panel
5. Verify GPUs are ranked by:
   - Allocated to me (tier 1)
   - Allocated to * (tier 2)
   - Idle unallocated (tier 3)
   - Light load unallocated (tier 4)
   - Busy (tier 5)

**Expected Result:**
- Top-ranked GPUs selected automatically
- Reasoning shown for each GPU (e.g., "idle 2h", "never used")
- Busy GPUs not selected unless no alternatives

### Scenario 4: Manual GPU Selection Mode

**Setup:**
- Start TUI: `bun index.ts`

**Steps:**
1. Press `l` to open command runner
2. Press `g` to toggle to manual mode
3. Navigate dashboard and click specific GPUs
4. Return to runner pane
5. Verify selected GPUs appear in assignment panel
6. Enter command and execute

**Expected Result:**
- Only manually clicked GPUs are selected
- No auto-ranking occurs
- Selected GPUs persist until manually deselected

### Scenario 5: My GPU View → Runner Workflow

**Setup:**
- Have GPUs allocated to your user
- Start TUI: `bun index.ts`

**Steps:**
1. Press `Ctrl+X`, then `t` to open tab switcher
2. Select "My GPU View"
3. Navigate to a GPU bundle
4. Press `l` to open runner from My GPU View
5. Verify GPU Assignment shows bundle GPUs pre-selected
6. Verify mode is "selected" (not auto)
7. Enter command and execute

**Expected Result:**
- Bundle GPUs automatically loaded into runner
- Mode set to "selected"
- Command executes only on bundle GPUs
- Source bundle tracked in state

### Scenario 6: Distribution Mode Toggle

**Setup:**
- Start TUI: `bun index.ts`

**Steps:**
1. Press `l` to open command runner
2. Verify initial mode: `Dist: one-to-one`
3. Press `Shift+Tab` to toggle
4. Verify mode changes to: `Dist: single`
5. Press `Shift+Tab` again
6. Verify mode returns to: `Dist: one-to-one`
7. Observe how command input changes between modes

**Expected Result:**
- Toggle cycles between single and one-to-one
- UI updates immediately
- Single mode: one input field
- One-to-one mode: multiple input fields (one per GPU)

### Scenario 7: Preflight Validation

**Setup:**
- Start TUI: `bun index.ts`

**Steps:**
1. Press `l` to open command runner
2. Observe Preflight Checks section
3. Try scenarios:
   - No tmux installed → shows fail + hint
   - Invalid command syntax → shows fail
   - No GPUs available → shows fail
   - All checks pass → shows all green checkmarks
4. Verify execution blocked when checks fail

**Expected Result:**
- Preflight checks update in real-time
- Execution disabled when checks fail
- Helpful hints shown for failures
- All must pass before execution allowed

### Scenario 8: Command-GPU Mapping Visual Feedback

**Setup:**
- Start TUI with 3+ available GPUs

**Steps:**
1. Press `l` to open command runner
2. Enter one-to-one mode
3. Add 3 commands (different per line)
4. Set GPU count to 3
5. Observe GPU Assignment Panel

**Expected Result:**
- Clear visual mapping: `Command N → GPU N`
- Each command paired with specific GPU
- GPU labels show node and index
- Reasoning displayed for auto-selected GPUs

### Scenario 9: Edge Case - No GPUs Available

**Setup:**
- Cluster with all GPUs allocated or busy

**Steps:**
1. Press `l` to open command runner
2. Try to add GPUs with `+`
3. Observe error handling

**Expected Result:**
- Error message: "No GPUs available"
- Execution disabled
- Helpful hint suggests freeing GPUs
- No crash or undefined behavior

### Scenario 10: Edge Case - Command Count Mismatch

**Setup:**
- Start TUI: `bun index.ts`

**Steps:**
1. Press `l` to open command runner
2. Set one-to-one mode
3. Enter 2 commands
4. Set GPU count to 3
5. Observe warning

**Expected Result:**
- Warning: "3 GPUs but only 2 commands"
- Option to add more commands or reduce GPUs
- Execution proceeds with available commands
- Empty slots handled gracefully

## Performance Testing

### Load Test: 100+ GPUs

**Setup:**
- Large cluster with 100+ GPUs
- Start TUI

**Steps:**
1. Open command runner
2. Set GPU count to 50
3. Measure rendering time
4. Test scrolling in GPU Assignment panel
5. Toggle modes and observe responsiveness

**Expected Result:**
- Rendering < 100ms
- Smooth scrolling
- No lag on mode toggles
- Memory usage stays reasonable

### Stress Test: Rapid Mode Switching

**Steps:**
1. Open command runner
2. Rapidly toggle between modes (Tab, Shift+Tab)
3. Rapidly adjust GPU count (+/-)
4. Observe stability

**Expected Result:**
- No crashes
- State remains consistent
- UI updates correctly
- No memory leaks

## Regression Testing

Before marking this task complete, verify all previous functionality still works:

- [ ] Basic navigation (j/k, arrows)
- [ ] Node selection and GPU detail view
- [ ] Allocation/deallocation (a/x keys)
- [ ] Process killing (K key)
- [ ] Tab switching (Ctrl+X, t)
- [ ] Help screen (?)
- [ ] Refresh (r key)
- [ ] Direct execution mode (non-tmux)
- [ ] Tmux session creation and reuse
- [ ] Error handling and display

## Test Results

### Automated Tests: ✓ PASSED (10/10)
- All automated tests passing
- No regressions detected

### Manual Tests: (To be executed)
- [ ] Scenario 1: Single-command multi-GPU
- [ ] Scenario 2: One-to-one cross-validation
- [ ] Scenario 3: Auto GPU selection
- [ ] Scenario 4: Manual GPU selection mode
- [ ] Scenario 5: My GPU View → Runner workflow
- [ ] Scenario 6: Distribution mode toggle
- [ ] Scenario 7: Preflight validation
- [ ] Scenario 8: Command-GPU mapping feedback
- [ ] Scenario 9: Edge case - No GPUs
- [ ] Scenario 10: Edge case - Command mismatch

### Performance Tests: (To be executed)
- [ ] Load test with 100+ GPUs
- [ ] Stress test rapid mode switching

### Regression Tests: (To be executed)
- [ ] All previous TUI features functional
