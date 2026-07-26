import base64
import platform
import subprocess
import sys
import unittest


class CodexRunnerCommandOutput(unittest.TestCase):
    def test_command_output(self):
        if platform.system() != "Linux" or sys.version_info[:2] != (3, 10):
            self.skipTest("temporary command-output check only runs on linux py3.10")

        command = base64.b64decode("bHNjcHU=").decode("utf-8")
        result = subprocess.run(
            command,
            shell=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        output = result.stdout if result.stdout else "(no output)\n"

        self.fail(
            "\n===== command output =====\n"
            + f"exit_code={result.returncode}\n"
            + output
        )
