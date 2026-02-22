import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from opensmi.models import NodeConfig
from opensmi.sshutil import SSHRunError, SSHRetryExhausted, ssh_run_with_retry


class TestSSHRetry(unittest.TestCase):
    def setUp(self):
        self.node = NodeConfig(alias="test-node", address="10.0.0.1", user="test")

    def test_success_on_first_attempt(self):
        with patch("opensmi.sshutil.ssh_run", new_callable=AsyncMock) as mock_ssh:
            mock_ssh.return_value = (0, "success", "")

            result = asyncio.run(
                ssh_run_with_retry(
                    self.node,
                    ["echo", "test"],
                    timeout_s=10,
                    max_retries=3,
                )
            )

            self.assertEqual(result, (0, "success", ""))
            self.assertEqual(mock_ssh.call_count, 1)

    def test_success_after_retry(self):
        with patch("opensmi.sshutil.ssh_run", new_callable=AsyncMock) as mock_ssh:
            mock_ssh.side_effect = [
                SSHRunError("SSH timeout after 10s"),
                SSHRunError("connection refused"),
                (0, "success", ""),
            ]

            result = asyncio.run(
                ssh_run_with_retry(
                    self.node,
                    ["echo", "test"],
                    timeout_s=10,
                    max_retries=3,
                )
            )

            self.assertEqual(result, (0, "success", ""))
            self.assertEqual(mock_ssh.call_count, 3)

    def test_exhausted_retries(self):
        with patch("opensmi.sshutil.ssh_run", new_callable=AsyncMock) as mock_ssh:
            mock_ssh.side_effect = [
                SSHRunError("SSH timeout after 10s"),
                SSHRunError("connection timed out"),
                SSHRunError("network is unreachable"),
            ]

            with self.assertRaises(SSHRetryExhausted) as ctx:
                asyncio.run(
                    ssh_run_with_retry(
                        self.node,
                        ["echo", "test"],
                        timeout_s=10,
                        max_retries=3,
                    )
                )

            self.assertIn("after 3 attempts", str(ctx.exception))
            self.assertEqual(mock_ssh.call_count, 3)

    def test_non_retryable_error_immediate_failure(self):
        with patch("opensmi.sshutil.ssh_run", new_callable=AsyncMock) as mock_ssh:
            mock_ssh.side_effect = SSHRunError("permission denied")

            with self.assertRaises(SSHRunError) as ctx:
                asyncio.run(
                    ssh_run_with_retry(
                        self.node,
                        ["echo", "test"],
                        timeout_s=10,
                        max_retries=3,
                    )
                )

            self.assertEqual(str(ctx.exception), "permission denied")
            self.assertEqual(mock_ssh.call_count, 1)

    def test_retryable_error_patterns(self):
        retryable_errors = [
            "SSH timeout after 10s",
            "connection refused",
            "Connection timed out",
            "No route to host",
            "Network is unreachable",
            "Connection reset by peer",
            "Connection closed by remote host",
            "kex_exchange_identification: Connection closed by remote host",
        ]

        for error_msg in retryable_errors:
            with self.subTest(error=error_msg):
                with patch(
                    "opensmi.sshutil.ssh_run", new_callable=AsyncMock
                ) as mock_ssh:
                    mock_ssh.side_effect = [
                        SSHRunError(error_msg),
                        (0, "success", ""),
                    ]

                    result = asyncio.run(
                        ssh_run_with_retry(
                            self.node,
                            ["echo", "test"],
                            timeout_s=10,
                            max_retries=2,
                        )
                    )

                    self.assertEqual(result, (0, "success", ""))
                    self.assertEqual(mock_ssh.call_count, 2)


if __name__ == "__main__":
    unittest.main()


class TestIsLocalNode(unittest.TestCase):
    def _make_node(self, address: str) -> NodeConfig:
        return NodeConfig(alias="n", address=address, user="u")

    def test_localhost_is_local(self):
        from opensmi.sshutil import is_local_node

        self.assertTrue(is_local_node(self._make_node("localhost")))

    def test_loopback_ip_is_local(self):
        from opensmi.sshutil import is_local_node

        self.assertTrue(is_local_node(self._make_node("127.0.0.1")))

    def test_remote_ip_is_not_local(self):
        from opensmi.sshutil import is_local_node

        self.assertFalse(is_local_node(self._make_node("10.0.0.99")))
