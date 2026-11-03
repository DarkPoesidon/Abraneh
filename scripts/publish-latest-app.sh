#!/bin/sh
# Keeps android-latest or windows-latest pointing at the newest app, under file names that never change.
# GitHub's own "latest" release must stay the server, which the installers download.
# The apps' updaters only read android-v* and windows-v* tags, so they ignore these two.
# Usage: publish-latest-app.sh <android|windows> <version> <folder with the release files>
set -eu
platform=$1 version=$2 folder=$3 tag=$platform-latest
: "${GITHUB_REPOSITORY:=DarkPoesidon/WIHM-Cloudflare}"
export GITHUB_REPOSITORY
if [ "$platform" = android ]; then
  name="اندروید"
  help='برای بیشتر گوشی‌ها فایل universal مناسب است. فایل‌های دیگر کوچک‌تر نیستند و فقط برای پردازندهٔ مشخص ساخته شده‌اند.'
else
  name="ویندوز"
  help='نصب‌کننده امضای دیجیتال ندارد. اگر ویندوز هشدار داد، More info و بعد Run anyway را بزنید.'
fi
notes="نسخهٔ $version برنامهٔ $name. این صفحه همیشه آخرین نسخه را دارد.

$help"
out=$(mktemp -d)
for file in "$folder"/*; do
  case "$file" in
    *.apk) cp "$file" "$out/wihm-messenger-android-$(basename "$file" | sed -E 's/^wihm-messenger-android-v[0-9.]+-//')" ;;
    *.exe) cp "$file" "$out/wihm-messenger-windows-setup.exe" ;;
  esac
done
(cd "$out" && sha256sum ./* | sed 's# \./# #' > SHA256SUMS.txt)
if gh release view "$tag" --repo "$GITHUB_REPOSITORY" > /dev/null 2>&1; then
  gh release upload "$tag" "$out"/* --repo "$GITHUB_REPOSITORY" --clobber
  gh release edit "$tag" --repo "$GITHUB_REPOSITORY" --notes "$notes" --latest=false
else
  gh release create "$tag" "$out"/* --repo "$GITHUB_REPOSITORY" --title "ابرانه برای $name: آخرین نسخه" --notes "$notes" --latest=false --target main
fi
rm -rf "$out"
