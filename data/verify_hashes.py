"""Verify SHA-256 digests of locally acquired market windows against data/window_manifest.json."""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
from pathlib import Path


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", type=Path, required=True, help="Directory containing locally acquired window CSV/JSON files.")
    args = ap.parse_args()

    manifest = json.loads((Path(__file__).resolve().parent / "window_manifest.json").read_text(encoding="utf-8"))
    matched, missing, mismatched = 0, 0, 0
    for w in manifest["windows"]:
        wid = w["windowId"]
        candidates = [args.dir / f"{wid}.csv", args.dir / f"{wid}.json"]
        found = next((p for p in candidates if p.exists()), None)
        if not found:
            print(f"[MISSING]  {wid}")
            missing += 1
            continue
        actual = sha256_file(found)
        expected = w["sourceFileSha256"]
        if actual == expected:
            print(f"[MATCH]    {wid} ({found.name})")
            matched += 1
        else:
            print(f"[MISMATCH] {wid}: expected {expected[:16]}..., got {actual[:16]}...")
            mismatched += 1
    print(f"\nSummary: matched={matched}, missing={missing}, mismatched={mismatched} (total={len(manifest['windows'])})")
    return 0 if mismatched == 0 and missing == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
