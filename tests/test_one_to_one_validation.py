"""
Tests for one-to-one mode validation logic.

Since one-to-one mode is implemented in the TUI (TypeScript), these tests
verify the validation rules that should be enforced:
1. All GPUs must have corresponding commands
2. Empty commands should be rejected
3. Command count must match GPU count
"""

import pytest


def validate_one_to_one_commands(
    commands: list[str], num_gpus: int
) -> tuple[bool, str]:
    """
    Validation logic for one-to-one mode.
    Returns (is_valid, error_message).
    """
    if not commands:
        return False, "At least one command must be provided"

    non_empty = [cmd for cmd in commands if cmd.strip()]

    if len(non_empty) == 0:
        return False, "At least one command must be provided"

    if len(non_empty) != num_gpus:
        return False, f"Expected {num_gpus} commands, got {len(non_empty)}"

    return True, ""


def test_valid_one_to_one():
    """All commands provided, matches GPU count."""
    commands = ["python train.py", "python eval.py", "python test.py"]
    is_valid, error = validate_one_to_one_commands(commands, 3)
    assert is_valid
    assert error == ""


def test_empty_commands_rejected():
    """Empty command list should be rejected."""
    commands = []
    is_valid, error = validate_one_to_one_commands(commands, 2)
    assert not is_valid
    assert "at least one command" in error.lower()


def test_all_whitespace_rejected():
    """All whitespace commands should be rejected."""
    commands = ["   ", "  ", "\t\n"]
    is_valid, error = validate_one_to_one_commands(commands, 3)
    assert not is_valid
    assert "at least one command" in error.lower()


def test_count_mismatch_too_few():
    """Fewer commands than GPUs should be rejected."""
    commands = ["python train.py", "python eval.py"]
    is_valid, error = validate_one_to_one_commands(commands, 3)
    assert not is_valid
    assert "Expected 3 commands, got 2" in error


def test_count_mismatch_too_many():
    """More commands than GPUs should be rejected."""
    commands = ["cmd1", "cmd2", "cmd3", "cmd4"]
    is_valid, error = validate_one_to_one_commands(commands, 3)
    assert not is_valid
    assert "Expected 3 commands, got 4" in error


def test_mixed_empty_and_valid():
    """Mix of empty and valid commands with count mismatch."""
    commands = ["python train.py", "  ", "python test.py"]
    is_valid, error = validate_one_to_one_commands(commands, 3)
    assert not is_valid
    assert "Expected 3 commands, got 2" in error


def test_single_gpu_single_command():
    """Edge case: single GPU with single command."""
    commands = ["python train.py"]
    is_valid, error = validate_one_to_one_commands(commands, 1)
    assert is_valid
    assert error == ""


def test_whitespace_trimming():
    """Commands with leading/trailing whitespace should still be valid."""
    commands = ["  python train.py  ", " python eval.py\n", "\tpython test.py"]
    is_valid, error = validate_one_to_one_commands(commands, 3)
    assert is_valid
    assert error == ""
