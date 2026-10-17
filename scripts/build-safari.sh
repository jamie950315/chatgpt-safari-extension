#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
PROJECT="$ROOT/safari/ChatGPT for Safari/ChatGPT for Safari.xcodeproj"
APP="ChatGPT for Safari.app"
IDENTITY="Apple Development"

mkdir -p "$ROOT/build" "$ROOT/dist"
python3 "$ROOT/scripts/prepare-safari.py"
xcodebuild \
  -project "$PROJECT" \
  -scheme "ChatGPT for Safari" \
  -configuration Release \
  -derivedDataPath "$ROOT/build/DerivedData" \
  -destination 'generic/platform=macOS' \
  ARCHS='arm64 x86_64' ONLY_ACTIVE_ARCH=NO \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$IDENTITY" \
  DEVELOPMENT_TEAM=N3JN8G9YWK \
  build > "$ROOT/build/xcodebuild.log" 2>&1 || {
    tail -n 80 "$ROOT/build/xcodebuild.log"
    exit 1
  }

BUILT="$ROOT/build/DerivedData/Build/Products/Release/$APP"
"$ROOT/scripts/build-bridge.sh" "$BUILT"
codesign --verify --deep --strict "$BUILT"
if [[ -e "$ROOT/dist/$APP" ]]; then
  BACKUP="$ROOT/dist/previous-$(date +%Y%m%d-%H%M%S)"
  mkdir "$BACKUP"
  mv "$ROOT/dist/$APP" "$BACKUP/$APP"
fi
ditto "$BUILT" "$ROOT/dist/$APP"
# LaunchServices can discover Xcode's intermediate bundle as a second installed
# copy. Two copies create different Safari extension origins/backgrounds and
# can leave the visible toolbar bound to the stale one. Register only dist.
/usr/bin/pluginkit -r "$BUILT/Contents/PlugIns/ChatGPT for Safari Extension.appex"
/usr/bin/pluginkit -a "$ROOT/dist/$APP/Contents/PlugIns/ChatGPT for Safari Extension.appex"
echo "Built: $ROOT/dist/$APP"
