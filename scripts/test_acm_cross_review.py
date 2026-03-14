#!/usr/bin/env python3
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "scripts" / "acm-cross-review.sh"


def write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


class CrossReviewScriptTests(unittest.TestCase):
    def run_script(self, review_args, extra_env=None):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            bin_dir = temp / "bin"
            bin_dir.mkdir()
            capture_path = temp / "reviewer-args.txt"
            prompt_path = temp / "reviewer-prompt.txt"

            write_executable(
                bin_dir / "codex",
                """#!/usr/bin/env bash
set -euo pipefail
capture_path="${ACM_TEST_CAPTURE:?}"
prompt_path="${ACM_TEST_PROMPT:?}"
printf '%s\n' "$@" >"${capture_path}"
cat >"${prompt_path}"
output_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-last-message)
      output_path="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
printf '{"status":"pass","summary":"ok","findings":[]}\n' >"${output_path}"
""",
            )
            write_executable(
                bin_dir / "claude",
                """#!/usr/bin/env bash
set -euo pipefail
capture_path="${ACM_TEST_CAPTURE:?}"
prompt_path="${ACM_TEST_PROMPT:?}"
printf '%s\n' "$@" >"${capture_path}"
cat >"${prompt_path}"
printf '{"status":"pass","summary":"ok","findings":[]}\n'
""",
            )
            write_executable(bin_dir / "acm", "#!/usr/bin/env bash\nexit 0\n")
            project_root = temp / "project-root"
            project_root.mkdir()

            env = os.environ.copy()
            env.update(
                {
                    "PATH": str(bin_dir) + os.pathsep + env.get("PATH", ""),
                    "ACM_PROJECT_ID": "test-project",
                    "ACM_RECEIPT_ID": "receipt-test",
                    "ACM_PROJECT_ROOT": str(project_root),
                    "ACM_TEST_CAPTURE": str(capture_path),
                    "ACM_TEST_PROMPT": str(prompt_path),
                }
            )
            if extra_env:
                env.update(extra_env)

            proc = subprocess.run(
                ["bash", str(SCRIPT_PATH), *review_args],
                cwd=REPO_ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn("PASS: ok", proc.stdout)
            args = [line.strip() for line in capture_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            prompt = prompt_path.read_text(encoding="utf-8")
            return args, prompt

    def run_script_expect_failure(self, review_args):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            bin_dir = temp / "bin"
            bin_dir.mkdir()
            write_executable(bin_dir / "codex", "#!/usr/bin/env bash\nexit 0\n")
            write_executable(bin_dir / "claude", "#!/usr/bin/env bash\nexit 0\n")
            write_executable(bin_dir / "acm", "#!/usr/bin/env bash\nexit 0\n")
            project_root = temp / "project-root"
            project_root.mkdir()

            env = os.environ.copy()
            env.update(
                {
                    "PATH": str(bin_dir) + os.pathsep + env.get("PATH", ""),
                    "ACM_PROJECT_ID": "test-project",
                    "ACM_RECEIPT_ID": "receipt-test",
                    "ACM_PROJECT_ROOT": str(project_root),
                }
            )

            proc = subprocess.run(
                ["bash", str(SCRIPT_PATH), *review_args],
                cwd=REPO_ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            return proc.stdout + proc.stderr

    def assert_sequence(self, args, want):
        for i in range(len(args) - len(want) + 1):
            if args[i : i + len(want)] == want:
                return
        self.fail(f"sequence {want!r} not found in {args!r}")

    def test_default_codex_args(self):
        args, _ = self.run_script([])
        self.assert_sequence(args, ["--model", "gpt-5.3-codex"])
        self.assert_sequence(args, ["-c", 'model_reasoning_effort="xhigh"'])
        self.assert_sequence(args, ["--sandbox", "read-only"])

    def test_codex_yolo_disables_sandbox(self):
        args, _ = self.run_script(["--provider", "codex", "--yolo"])
        self.assert_sequence(args, ["--yolo"])
        self.assertNotIn("--sandbox", args)

    def test_claude_print_mode(self):
        args, prompt = self.run_script(["--provider", "claude", "--model", "sonnet"])
        self.assert_sequence(args, ["-p"])
        self.assert_sequence(args, ["--model", "sonnet"])
        self.assert_sequence(args, ["--output-format", "json"])
        self.assertIn("--json-schema", args)
        self.assertIn("Review the current task-scoped uncommitted changes", prompt)

    def test_claude_yolo_maps_to_dangerous_permissions(self):
        args, _ = self.run_script(["--provider", "claude", "--yolo"])
        self.assert_sequence(args, ["-p"])
        self.assert_sequence(args, ["--dangerously-skip-permissions"])

    def test_claude_explicit_dangerous_permissions(self):
        args, _ = self.run_script(["--provider", "claude", "--dangerously-skip-permissions"])
        self.assert_sequence(args, ["-p"])
        self.assert_sequence(args, ["--dangerously-skip-permissions"])

    def test_rejects_claude_sandbox_flag(self):
        output = self.run_script_expect_failure(["--provider", "claude", "--sandbox", "read-only"])
        self.assertIn("--sandbox is only supported with --provider codex", output)

    def test_rejects_codex_dangerous_permissions_flag(self):
        output = self.run_script_expect_failure(["--provider", "codex", "--dangerously-skip-permissions"])
        self.assertIn("--dangerously-skip-permissions is only supported with --provider claude", output)

    def test_allows_codex_when_dangerous_permissions_env_is_false(self):
        args, _ = self.run_script(["--provider", "codex"], {"ACM_CROSS_REVIEW_DANGEROUSLY_SKIP_PERMISSIONS": "false"})
        self.assert_sequence(args, ["--model", "gpt-5.3-codex"])


if __name__ == "__main__":
    unittest.main()
