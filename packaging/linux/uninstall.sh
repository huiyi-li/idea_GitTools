#!/usr/bin/env bash
set -euo pipefail

APP_NAME="ideagittool"

if [[ "${EUID}" -eq 0 ]]; then
  PREFIX="/usr/local"
  DESKTOP_DIR="/usr/share/applications"
  ICON_DIR="/usr/share/icons/hicolor/128x128/apps"
else
  PREFIX="${HOME}/.local"
  DESKTOP_DIR="${HOME}/.local/share/applications"
  ICON_DIR="${HOME}/.local/share/icons/hicolor/128x128/apps"
fi

rm -f "${PREFIX}/bin/ideagittool-desktop"
rm -rf "${PREFIX}/share/licenses/${APP_NAME}"
rm -f "${DESKTOP_DIR}/${APP_NAME}.desktop" "${ICON_DIR}/${APP_NAME}.png"

echo "Uninstalled IdeaGitTool from ${PREFIX}."
