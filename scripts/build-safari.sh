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
codesign --verify --deep --strict "$BUILT"
if [[ -e "$ROOT/dist/$APP" ]]; then
  BACKUP="$ROOT/dist/previous-$(date +%Y%m%d-%H%M%S)"
  mkdir "$BACKUP"
  mv "$ROOT/dist/$APP" "$BACKUP/$APP"
fi
ditto "$BUILT" "$ROOT/dist/$APP"
echo "Built: $ROOT/dist/$APP"
