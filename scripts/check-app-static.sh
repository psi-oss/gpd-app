#!/usr/bin/env bash
set -euo pipefail

# Browser-native modal dialogs can deadlock or trap input inside Tauri/WebKit
# when opened from app-owned dialogs. Use Solid/Kobalte UI or inline confirms.
pattern='window\.(alert|confirm|prompt)[[:space:]]*\('

if grep -RInE --include='*.ts' --include='*.tsx' "$pattern" packages/app/src packages/desktop/src; then
  echo "::error::Do not use window.alert/window.confirm/window.prompt in app or desktop UI code."
  echo "::error::Use an app-rendered dialog, toast, or inline confirmation instead."
  exit 1
fi

echo "app static gates passed"
