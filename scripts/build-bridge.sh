#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
APP="$1"
EXTENSION="$APP/Contents/PlugIns/ChatGPT for Safari Extension.appex"
SERVICE="$EXTENSION/Contents/XPCServices/Safari Native Bridge.xpc"
mkdir -p "$ROOT/build/native" "$SERVICE/Contents/MacOS"
cp "$ROOT/companion/relay/vendor/BabelStandalone.js" "$APP/Contents/Resources/BabelStandalone.js"
cp "$ROOT/companion/relay/vendor/BabelStandalone.LICENSE" "$APP/Contents/Resources/BabelStandalone.LICENSE"
for ARCH in arm64 x86_64; do
  xcrun swiftc -swift-version 5 -O -target "$ARCH-apple-macos14.0" \
    "$ROOT/native/CompanionClient.swift" "$ROOT/native/BridgeService.swift" "$ROOT/native/main.swift" \
    -o "$ROOT/build/native/bridge-$ARCH"
done
lipo -create "$ROOT/build/native/bridge-arm64" "$ROOT/build/native/bridge-x86_64" \
  -output "$SERVICE/Contents/MacOS/Safari Native Bridge"
cp "$ROOT/native/Info.plist" "$SERVICE/Contents/Info.plist"
codesign --force --options runtime --sign 'Apple Development' "$SERVICE"
codesign --force --preserve-metadata=entitlements,requirements,flags --sign 'Apple Development' "$EXTENSION"
codesign --force --preserve-metadata=entitlements,requirements,flags --sign 'Apple Development' "$APP"
