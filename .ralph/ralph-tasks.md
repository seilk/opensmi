# Ralph Tasks

## Iteration 1 - P0 Complete

- [x] P0: Map code paths and lock data contracts

## Iteration 2+ - Implementation

### P1: Targeted Command Routing
- [ ] P1.1: Implement one-to-one mode backend orchestration
- [ ] P1.2: Add multi-node parallel execution with asyncio.gather
- [ ] P1.3: Add per-GPU CUDA_VISIBLE_DEVICES injection for one-to-one mode
- [ ] P1.4: Add validation: command count == GPU count for one-to-one
- [ ] P1.5: Add tests for one-to-one mode execution
- [ ] P1.6: Add tests for multi-node execution
- [ ] P1.7: Verify shell injection safety with metacharacters

### P2: Remote Preflight Checks
- [ ] P2.1: Implement run_preflight_checks() function
- [ ] P2.2: Implement tmux availability check (which tmux)
- [ ] P2.3: Implement GPU availability check (reuse existing validate_gpu_availability)
- [ ] P2.4: Implement command syntax validation (bash -n -c)
- [ ] P2.5: Add actionable error messages for each failure type
- [ ] P2.6: Add tests for preflight check success cases
- [ ] P2.7: Add tests for preflight check failure cases
- [ ] P2.8: Integrate preflight into route_command_to_target (optional flag)

### P3: Virtual Bundle Logic (DDP)
- [ ] P3.1: Implement DistributedExecutionPlan data model
- [ ] P3.2: Implement create_distributed_execution_plan() function
- [ ] P3.3: Implement deterministic rank assignment algorithm
- [ ] P3.4: Implement master selection (first node = rank 0)
- [ ] P3.5: Implement RANK/WORLD_SIZE/MASTER_ADDR/MASTER_PORT injection
- [ ] P3.6: Add execute_distributed_plan() function
- [ ] P3.7: Add tests for DDP env var injection
- [ ] P3.8: Add tests for multi-node DDP orchestration

### P4: Hardening & Documentation
- [ ] P4.1: Add integration tests for multi-node execution
- [ ] P4.2: Add tests for partial failure scenarios
- [ ] P4.3: Document race conditions and mitigation strategies
- [ ] P4.4: Document failure modes and recovery procedures
- [ ] P4.5: Add retry logic for transient failures
- [ ] P4.6: Update README.md with new capabilities
- [ ] P4.7: Update ARCHITECTURE.md with execution flow
- [ ] P4.8: Run full pytest suite and verify no regressions

## Stabilization (Iterations 9-10)
- [ ] Final regression test sweep
- [ ] Performance profiling for multi-node execution
- [ ] Edge case testing (1 GPU, 100 GPUs, mixed nodes)
- [ ] Documentation review and polish
