#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

BIN_DIR="${PREFIX}/bin"
DOC_DIR="${PREFIX}/share/licenses/${APP_NAME}"

echo "Installing IdeaGitTool to ${PREFIX}..."
install -d "${BIN_DIR}" "${DOC_DIR}" "${DESKTOP_DIR}" "${ICON_DIR}"

install -m 755 "${SCRIPT_DIR}/bin/ideagittool-desktop" "${BIN_DIR}/ideagittool-desktop"
install -m 644 "${SCRIPT_DIR}/LICENSE" "${DOC_DIR}/LICENSE"
install -m 644 "${SCRIPT_DIR}/NOTICE" "${DOC_DIR}/NOTICE"
install -m 644 "${SCRIPT_DIR}/licenses/UPSTREAM_LICENSE.txt" "${DOC_DIR}/UPSTREAM_LICENSE.txt"
install -m 644 "${SCRIPT_DIR}/share/ideagittool.desktop" "${DESKTOP_DIR}/${APP_NAME}.desktop"
install -m 644 "${SCRIPT_DIR}/share/ideagittool.png" "${ICON_DIR}/${APP_NAME}.png"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${DESKTOP_DIR}" >/dev/null 2>&1 || true
fi

echo "Done! Launch with: ${BIN_DIR}/ideagittool-desktop"
