"""Convenience launcher for the Modal app.

This script:
1. Loads `.env` file variables (including MODAL_TOKEN_ID & MODAL_TOKEN_SECRET).
2. If Modal credentials are provided in `.env`, registers them via `modal token set`.
3. Runs `modal serve main.py` with UTF-8 encoding enabled.
"""

import os
import subprocess
import sys

# Ensure UTF-8 output encoding on Windows consoles
os.environ["PYTHONIOENCODING"] = "utf-8"
os.environ["PYTHONUTF8"] = "1"
if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

from dotenv import load_dotenv

load_dotenv()


def main():
    token_id = os.getenv("MODAL_TOKEN_ID", "").strip()
    token_secret = os.getenv("MODAL_TOKEN_SECRET", "").strip()

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"

    if token_id and token_secret:
        print("[*] Found Modal credentials in .env. Configuring Modal client...")
        try:
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "modal",
                    "token",
                    "set",
                    "--token-id",
                    token_id,
                    "--token-secret",
                    token_secret,
                    "--no-verify",
                ],
                env=env,
                check=True,
            )
            print("[+] Modal token configured successfully.")
        except subprocess.CalledProcessError as e:
            print(f"[!] Warning: Failed to configure modal token: {e}")

    print("[*] Launching Modal serve...")
    try:
        subprocess.run(
            [sys.executable, "-m", "modal", "serve", "main.py"],
            env=env,
            check=True,
        )
    except KeyboardInterrupt:
        print("\n[*] Modal server stopped.")


if __name__ == "__main__":
    main()
