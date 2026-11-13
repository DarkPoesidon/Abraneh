#!/bin/sh
# Copies the newest Android and Windows app files onto a server release, so one page has every download.
# They come from android-latest and windows-latest, which already hold them under names that never change.
# Usage: release-apps.sh <server release tag>
set -eu
tag=$1
: "${GITHUB_REPOSITORY:=DarkPoesidon/WIHM-Cloudflare}"
out=$(mktemp -d)
# A repository that has not published an app yet simply gets none.
gh release download android-latest --repo "$GITHUB_REPOSITORY" --dir "$out" --pattern '*.apk' || true
gh release download windows-latest --repo "$GITHUB_REPOSITORY" --dir "$out" --pattern '*.exe' || true
if [ -n "$(ls "$out")" ]; then
  # A file of its own: the server's SHA256SUMS stays as the installer wrote it.
  (cd "$out" && sha256sum ./* | sed 's# \./# #' > SHA256SUMS-apps.txt)
  gh release upload "$tag" "$out"/* --repo "$GITHUB_REPOSITORY" --clobber
fi
rm -rf "$out"
