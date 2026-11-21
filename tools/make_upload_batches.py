#!/usr/bin/env python3
"""Sort the project into drag-and-drop batches for GitHub's website, which takes about 100 files at a time.

    python3 tools/make_upload_batches.py          # only what changed since the last run (everything the first time)
    python3 tools/make_upload_batches.py --all    # everything, from scratch

Batches land in upload/ (git-ignored) as batch-01, batch-02, ... Each keeps the project's folder structure,
so dropping the CONTENTS of a batch on the repository's "Upload files" page puts every file in the right
place. upload/README.txt repeats the steps and lists any files that were deleted since last time.

The script remembers what it has batched in upload/.manifest.json. If you made batches but did not upload
them, run with --all next time.
"""
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "upload"
MANIFEST = OUT / ".manifest.json"
PER_BATCH = 95                                   # GitHub's limit is 100; leave room for a stray file
SKIP_DIRS = {"raw", "reference", "upload", ".claude", ".git", "__pycache__"}
SKIP_FILES = {".DS_Store"}


def project_files():
    files = []
    for p in sorted(ROOT.rglob("*")):
        rel = p.relative_to(ROOT)
        if p.is_file() and not (set(rel.parts[:-1]) & SKIP_DIRS) and p.name not in SKIP_FILES:
            files.append(rel)
    # Small, human-facing files first; the star-catalogue tiles (over a thousand of them) last.
    return sorted(files, key=lambda r: (r.parts[:2] == ("data", "tycho"), len(r.parts) > 1, str(r)))


def main():
    everything = "--all" in sys.argv
    old = {} if everything or not MANIFEST.exists() else json.loads(MANIFEST.read_text())
    current = {str(rel): hashlib.sha1((ROOT / rel).read_bytes()).hexdigest() for rel in project_files()}
    changed = [rel for rel, digest in current.items() if old.get(rel) != digest]
    deleted = sorted(set(old) - set(current))

    OUT.mkdir(exist_ok=True)
    for stale in OUT.glob("batch-*"):
        shutil.rmtree(stale)
    # The app itself goes first, in batches of its own; the catalogue tiles follow.
    app = [rel for rel in changed if not rel.startswith("data/tycho/")]
    tiles = [rel for rel in changed if rel.startswith("data/tycho/")]
    batches = [group[i:i + PER_BATCH] for group in (app, tiles) for i in range(0, len(group), PER_BATCH)]
    for n, batch in enumerate(batches, 1):
        for rel in batch:
            dest = OUT / f"batch-{n:02d}" / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, dest)
    MANIFEST.write_text(json.dumps(current, indent=0, sort_keys=True))

    lines = [
        "Atlastellar upload batches",
        "",
        f"{len(changed)} file(s) to upload in {len(batches)} batch(es)." if changed else "Nothing has changed since the last run. There is nothing to upload.",
        "",
        "For each batch, in order:",
        "  1. On the repository's main page on github.com choose Add file > Upload files.",
        "     (Always start from the main page, not from inside a folder.)",
        "  2. In Finder open the batch folder, press Cmd+Shift+. so hidden files show, select everything",
        "     inside it (Cmd+A) and drag it onto the page. Drag the contents, not the batch folder itself.",
        "  3. Wait for the list to finish loading, then press Commit changes.",
        "",
        "If a .DS_Store file tags along, it is harmless; remove it from the list before committing if you like.",
    ]
    for n, batch in enumerate(batches, 1):
        what = "star-catalogue tiles" if batch[0].startswith("data/tycho/") else ", ".join(sorted({rel.split("/")[0] for rel in batch}))
        lines.append(f"  batch-{n:02d}: {len(batch):3d} files  ({what})")
    if deleted:
        lines += ["", "These files no longer exist in the project. Delete them on GitHub (open the file, then the bin icon):"]
        lines += [f"  {rel}" for rel in deleted]
    (OUT / "README.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
