#!/usr/bin/env python3
"""Run the e2e client with a hard timeout (macOS has no timeout(1))."""
import os
import subprocess
import sys

script = sys.argv[1] if len(sys.argv) > 1 else "scripts/e2e-remote-host-client.ts"
timeout = float(os.environ.get("E2E_CLIENT_TIMEOUT", "45"))
p = subprocess.Popen(["bun", script], env=os.environ.copy())
try:
    rc = p.wait(timeout=timeout)
except subprocess.TimeoutExpired:
    p.kill()
    try:
        p.wait(timeout=5)
    except Exception:
        pass
    print(f"client timed out after {timeout}s", file=sys.stderr)
    sys.exit(1)
sys.exit(rc)
