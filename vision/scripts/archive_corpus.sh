#!/usr/bin/env bash
# Archive the owned endline-VOD corpus with yt-dlp (M2).
#
# Downloads the 33 primary endline candidates from the checked-in catalog to
# $CORPUS_DIR, skipping already-archived IDs. 2026 YouTube reality: needs a
# recent yt-dlp plus the bgutil-ytdlp-pot-provider plugin and browser cookies
# for reliable full-rate downloads (SABR rollout).
#
# Usage:
#   CORPUS_DIR=/Volumes/BigDisk/scorecheck-corpus ./scripts/archive_corpus.sh
#
# Space estimate: ~157 h of 1080p30 at YouTube rates ≈ 100–200 GB.

set -euo pipefail

CORPUS_DIR="${CORPUS_DIR:?set CORPUS_DIR to the archive destination}"
CATALOG="$(cd "$(dirname "$0")/.." && pwd)/data/provided-youtube-livestream-sources-v1.json"

mkdir -p "$CORPUS_DIR"

command -v yt-dlp >/dev/null || {
  echo "yt-dlp not found; install with: brew install yt-dlp" >&2
  exit 1
}

python3 - "$CATALOG" <<'EOF' > "$CORPUS_DIR/download-urls.txt"
import json, sys
catalog = json.load(open(sys.argv[1]))
for source in catalog["sources"]:
    if source.get("primary_endline_candidate"):
        print(source["canonical_watch_url"])
EOF

echo "$(wc -l < "$CORPUS_DIR/download-urls.txt") URLs queued"

yt-dlp \
  --batch-file "$CORPUS_DIR/download-urls.txt" \
  --download-archive "$CORPUS_DIR/archive.txt" \
  -f "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]" \
  --merge-output-format mp4 \
  --no-overwrites --continue --ignore-errors \
  --cookies-from-browser chrome \
  --write-info-json \
  -o "$CORPUS_DIR/%(id)s/%(id)s.%(ext)s"

echo "corpus at $CORPUS_DIR"
