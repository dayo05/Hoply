#!/usr/bin/env bash
set -euo pipefail

# Build an unsigned device IPA. AltStore Classic supplies the signing identity.
# --portable-resources avoids actool/ibtool when local simulator services are broken.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORTABLE=0
if [ "${1:-}" = "--portable-resources" ]; then
  PORTABLE=1
  shift
fi
if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [--portable-resources] [output.ipa]" >&2
  exit 2
fi
OUTPUT="${1:-$ROOT/.build/altstore/Hoply.ipa}"
mkdir -p "$(dirname "$OUTPUT")"
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
BUILD_DIR="${HOPLY_IPA_BUILD_DIR:-$ROOT/.build/altstore}"
mkdir -p "$BUILD_DIR"
BUILD_DIR="$(cd "$BUILD_DIR" && pwd)"
RESOURCE_SETTINGS=("EXCLUDED_SOURCE_FILE_NAMES=")
if [ "$PORTABLE" = 1 ]; then
  RESOURCE_SETTINGS=("EXCLUDED_SOURCE_FILE_NAMES=Assets.xcassets LaunchScreen.storyboard")
fi

cd "$ROOT"
npm run build:viewer
xcodebuild -project ios/Hoply.xcodeproj -target Hoply -sdk iphoneos \
  -configuration Release ARCHS=arm64 ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO \
  "SYMROOT=$BUILD_DIR/products" "OBJROOT=$BUILD_DIR/intermediates" \
  "${RESOURCE_SETTINGS[@]}" build

STAGE="$(mktemp -d "$BUILD_DIR/package.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/Payload"
ditto "$BUILD_DIR/products/Release-iphoneos/Hoply.app" "$STAGE/Payload/Hoply.app"
python3 - "$ROOT" "$STAGE/Payload/Hoply.app" "$PORTABLE" <<'PY'
import json
from pathlib import Path
import plistlib
import shutil
import sys

root, app = map(Path, sys.argv[1:3])
if sys.argv[3] == "1":
    assets = root / "ios/Hoply/Assets.xcassets"
    # UIKit accepts individual PNG app/document icons in the main bundle.
    for asset in ("AppIcon.appiconset", "HWPDocumentIcon.imageset", "HWPXDocumentIcon.imageset"):
        manifest = json.loads((assets / asset / "Contents.json").read_text())
        for item in manifest["images"]:
            if "filename" in item and item.get("idiom") != "ios-marketing":
                shutil.copy2(assets / asset / item["filename"], app / item["filename"])
    info_path = app / "Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    info.pop("UILaunchStoryboardName", None)
    info["UILaunchScreen"] = {}
    for key, names in {
        "CFBundleIcons": ["Icon-20", "Icon-29", "Icon-40", "Icon-60"],
        "CFBundleIcons~ipad": ["Icon-20", "Icon-29", "Icon-40", "Icon-76", "Icon-83.5"],
    }.items():
        info[key] = {"CFBundlePrimaryIcon": {"CFBundleIconFiles": names}}
    info_path.write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY))

for bundle, executable in [(app, "Hoply"), (app / "PlugIns/HoplyQuickLook.appex", "HoplyQuickLook")]:
    assert (bundle / executable).is_file(), f"Missing executable: {bundle}"
    assert (bundle / "ViewerBundle/index.html").is_file(), f"Missing viewer: {bundle}"
    assert list((bundle / "ViewerBundle/assets").glob("*.wasm")), f"Missing renderer: {bundle}"
PY
ditto -c -k --norsrc --keepParent "$STAGE/Payload" "$OUTPUT"
echo "Unsigned AltStore Classic IPA: $OUTPUT"
