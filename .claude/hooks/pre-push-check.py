#!/usr/bin/env python3
"""Pre-push format/lint gate for Bili-SyncPlay.

Invoked by a PreToolUse Bash hook (see .claude/settings.json). Reads the
tool_input JSON from stdin and:
  * exits 0 (allow) when the command is not a git push
  * runs `npm run format:check` and `npm run lint` when it is a push
  * exits 2 (block) on any failure, including inability to locate the repo

Fail-closed on ambiguity: if we cannot find a package.json project root for
the push, we refuse rather than silently allowing an unchecked push.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

# Git global flags whose argument is a separate shell token (not `--flag=value`).
GIT_FLAGS_WITH_ARG = {
    "-c",
    "-C",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--exec-path",
    "--config-env",
}

# Split a full command line into shell segments on control operators so each
# segment can be tokenized independently.
SEGMENT_SPLIT = re.compile(r"\|\|?|&&|[;&\n()]")

CD_RE = re.compile(r"(?:^|[;&|\s])cd\s+([^\s;&|]+)")


def is_git_push(cmd: str) -> bool:
    """Return True if any shell segment in `cmd` invokes `git push`.

    Properly handles forms like:
      git push / git push -u origin main
      git -c color.ui=always push / git -C /repo push
      /usr/bin/git --git-dir=/r/.git push
      cd /repo && git push
    And avoids false positives like `git commit -m "git push"` (quoted).
    """
    for segment in SEGMENT_SPLIT.split(cmd):
        segment = segment.strip()
        if not segment:
            continue
        try:
            tokens = shlex.split(segment)
        except ValueError:
            continue
        i = 0
        while i < len(tokens):
            tok = tokens[i]
            if tok == "git" or tok.endswith("/git"):
                j = i + 1
                while j < len(tokens):
                    t = tokens[j]
                    if not t.startswith("-"):
                        if t == "push":
                            return True
                        break
                    if t in GIT_FLAGS_WITH_ARG:
                        j += 2
                    else:
                        j += 1
                break
            i += 1
    return False


def find_repo_root(start: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", start, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    root = result.stdout.strip()
    if root and Path(root, "package.json").is_file():
        return root
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    cmd = (payload.get("tool_input") or {}).get("command") or ""
    if not is_git_push(cmd):
        return 0

    root = find_repo_root(os.getcwd())
    if root is None:
        match = CD_RE.search(cmd)
        if match:
            root = find_repo_root(match.group(1))

    if root is None:
        print(
            "pre-push check: cannot locate project root with package.json — "
            "refusing to allow push without verification",
            file=sys.stderr,
        )
        return 2

    for step in (["npm", "run", "format:check"], ["npm", "run", "lint"]):
        result = subprocess.run(step, cwd=root)
        if result.returncode != 0:
            print(
                "pre-push checks failed — fix format/lint locally, then retry push",
                file=sys.stderr,
            )
            return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
