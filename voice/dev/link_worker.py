"""Gives the local Worker the LiveKit project from voice/.env.local, so it can sign the browser's pass.

    uv run python dev/link_worker.py

Copies LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET into worker/.dev.vars,
replacing them if they are there. Prints which settings it copied, never their values.
Both files are ignored by git.
"""

from __future__ import annotations

import re
from pathlib import Path

VOICE = Path(__file__).resolve().parents[1]
SOURCE = VOICE / ".env.local"
TARGET = VOICE.parent / "worker" / ".dev.vars"
NAMES = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def main() -> None:
    source = read(SOURCE)
    values = {}
    for name in NAMES:
        found = re.search(rf"^{name}=([^\r\n]*)", source, re.M)
        value = found.group(1).strip() if found else ""
        if not value:
            raise SystemExit(f"{name} is empty in {SOURCE.name}: paste it there first")
        values[name] = value
    if not re.fullmatch(r"wss://[A-Za-z0-9.-]+", values["LIVEKIT_URL"]):
        raise SystemExit("LIVEKIT_URL must look like wss://<project>.livekit.cloud")

    target = read(TARGET)
    newline = "\r\n" if "\r\n" in target else "\n"
    for name, value in values.items():
        line = f"{name}={value}"
        if re.search(rf"^{name}=", target, re.M):
            target = re.sub(rf"^{name}=[^\r\n]*", lambda _match, line=line: line, target, flags=re.M)
        else:
            target = target.rstrip("\r\n") + newline + line + newline
    TARGET.write_text(target, encoding="utf-8", newline="")
    print(f"Copied {', '.join(NAMES)} into {TARGET.relative_to(VOICE.parent)}. Restart wrangler dev if it does not reload.")


if __name__ == "__main__":
    main()
