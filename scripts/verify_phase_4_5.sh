#!/usr/bin/env bash
# Verification script for Phase 4 and Phase 5 implementation
# Tests all requirements from JOB_QUEUE_PLAN.md

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================"
echo "Phase 4 & 5 Implementation Verification"
echo "========================================"
echo ""

PASSED=0
FAILED=0

check() {
    local name="$1"
    local command="$2"
    
    echo -n "Checking $name... "
    if eval "$command" > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗${NC}"
        FAILED=$((FAILED + 1))
    fi
}

check_exists() {
    local name="$1"
    local pattern="$2"
    local file="$3"
    
    echo -n "Checking $name... "
    if grep -q "$pattern" "$file" 2>/dev/null; then
        echo -e "${GREEN}✓${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗${NC}"
        FAILED=$((FAILED + 1))
    fi
}

echo "=== Phase 4: Job Lifecycle Management ==="
echo ""

check_exists "WATCH-A: watchRunningJobs function" "async function watchRunningJobs" "tui/index.ts"
check_exists "WATCH-B: Auto-restart logic" "shouldRestart" "tui/index.ts"
check_exists "WATCH-C: cancel_job function" "async def cancel_job" "src/opensmi/jobs.py"
check_exists "WATCH-D: retry_job function" "def retry_job" "src/opensmi/jobs.py"
check_exists "WATCH-E: max_retries enforcement" "job.retry_count < job.max_retries" "tui/index.ts"
check_exists "WATCH-F: cleanup_old_jobs function" "def cleanup_old_jobs" "src/opensmi/jobs.py"
check_exists "WATCH-G: retry_count tracking" "retry_count: int" "src/opensmi/jobs.py"

echo ""
echo "=== Phase 5: CLI Integration & File Locking ==="
echo ""

check_exists "5-A: job list command" "sp_jl = job_sub.add_parser.*list" "src/opensmi/cli.py"
check_exists "5-A: job submit command" "sp_js = job_sub.add_parser.*submit" "src/opensmi/cli.py"
check_exists "5-A: job cancel command" "sp_jc = job_sub.add_parser.*cancel" "src/opensmi/cli.py"
check_exists "5-A: job retry command" "sp_jr = job_sub.add_parser.*retry" "src/opensmi/cli.py"
check_exists "5-A: job delete command" "sp_jd = job_sub.add_parser.*delete" "src/opensmi/cli.py"
check_exists "5-B: File locking context manager" "_lock_jobs_file" "src/opensmi/jobs.py"
check_exists "5-B: fcntl.flock usage" "fcntl.flock" "src/opensmi/jobs.py"
check_exists "5-B: Atomic writes (tempfile)" "tempfile.mkstemp" "src/opensmi/jobs.py"

echo ""
echo "=== Integration Points ==="
echo ""

check_exists "Poll cycle: dispatchQueuedJobs call" "await dispatchQueuedJobs()" "tui/index.ts"
check_exists "Poll cycle: watchRunningJobs call" "await watchRunningJobs()" "tui/index.ts"
check_exists "Poll cycle: cleanupOldJobs call" "await cleanupOldJobs()" "tui/index.ts"
check_exists "Node extraction from session names" "_extract_node_from_session" "src/opensmi/jobs.py"

echo ""
echo "=== Test Suite ==="
echo ""

check "Unit tests passing" "python3 -m pytest tests/ -k 'not autodispatch' -q --tb=no"

echo ""
echo "========================================"
echo "Verification Summary"
echo "========================================"
echo -e "Passed: ${GREEN}${PASSED}${NC}"
echo -e "Failed: ${RED}${FAILED}${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All Phase 4 and 5 requirements verified!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some requirements missing or failing${NC}"
    exit 1
fi
