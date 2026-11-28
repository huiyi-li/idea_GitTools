#!/usr/bin/env bash
set -euo pipefail

# Build Arch Linux .pkg.tar.zst and pacman repository database (.db.tar.gz + .db)
# Usage: scripts/build_arch_repo.sh <tarball_path> <output_dir>

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARBALL="${1:-}"
OUT_DIR="${2:-${ROOT_DIR}/release-arch}"

if [[ -z "${TARBALL}" || ! -f "${TARBALL}" ]]; then
  echo "Usage: $0 <path-to-IdeaGitTool_<ver>_linux-x86_64.tar.gz> [output_dir]" >&2
  exit 1
fi

TARBALL="$(cd "$(dirname "${TARBALL}")" && pwd)/$(basename "${TARBALL}")"
mkdir -p "${OUT_DIR}"
OUT_DIR="$(cd "${OUT_DIR}" && pwd)"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

cp "${ROOT_DIR}/packaging/arch/ideagittool-bin/PKGBUILD" "${WORK_DIR}/PKGBUILD"
cp "${TARBALL}" "${WORK_DIR}/"
tar_ver="$(basename "${TARBALL}" | sed -E 's/^IdeaGitTool_([^_]+)_linux-x86_64\.tar\.gz$/\1/')"
if [[ -n "${tar_ver}" && "${tar_ver}" != "$(basename "${TARBALL}")" ]]; then
  sed -i "s/^pkgver=.*/pkgver=${tar_ver}/" "${WORK_DIR}/PKGBUILD"
fi

(
  cd "${WORK_DIR}"
  makepkg -f -d --skipinteg
)

cp -f "${WORK_DIR}"/*.pkg.tar.zst "${OUT_DIR}/"

rm -f "${OUT_DIR}"/ideagittool.db* "${OUT_DIR}"/ideagittool.files*
repo-add "${OUT_DIR}/ideagittool.db.tar.gz" "${OUT_DIR}"/*.pkg.tar.zst

# GitHub Releases does not preserve symlinks; replace symlinks with real file copies
# so `pacman -Sy` downloading .../ideagittool.db works directly.
rm -f "${OUT_DIR}/ideagittool.db" "${OUT_DIR}/ideagittool.files"
cp -L "${OUT_DIR}/ideagittool.db.tar.gz" "${OUT_DIR}/ideagittool.db"
cp -L "${OUT_DIR}/ideagittool.files.tar.gz" "${OUT_DIR}/ideagittool.files"

ls -lh "${OUT_DIR}/"
