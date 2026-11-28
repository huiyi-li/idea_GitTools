#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Packages IdeaGitTool for Linux into a portable .tar.gz archive with .sha256 checksum.
"""

import hashlib
import json
import shutil
import sys
import tarfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
RELEASE_DIR = ROOT_DIR / "release"


def get_version() -> str:
    if len(sys.argv) > 1 and sys.argv[1].strip():
        return sys.argv[1].strip().lstrip("v")
    pkg = json.loads((ROOT_DIR / "package.json").read_text(encoding="utf-8"))
    return pkg["version"]


def main():
    version = get_version()
    pkg_name = f"IdeaGitTool_{version}_linux-x86_64"
    stage_dir = RELEASE_DIR / pkg_name
    tar_path = RELEASE_DIR / f"{pkg_name}.tar.gz"

    app_bin = ROOT_DIR / "src-tauri" / "target" / "release" / "ideagittool-desktop"
    desktop_file = ROOT_DIR / "packaging" / "linux" / "ideagittool.desktop"
    icon_file = ROOT_DIR / "src-tauri" / "icons" / "128x128.png"
    install_sh = ROOT_DIR / "packaging" / "linux" / "install.sh"
    uninstall_sh = ROOT_DIR / "packaging" / "linux" / "uninstall.sh"

    required = [app_bin, desktop_file, icon_file, install_sh, uninstall_sh]
    missing = [str(p) for p in required if not p.is_file()]
    if missing:
        raise FileNotFoundError("Missing required build artifacts:\n  " + "\n  ".join(missing))

    if stage_dir.exists():
        shutil.rmtree(stage_dir)
    RELEASE_DIR.mkdir(parents=True, exist_ok=True)

    (stage_dir / "bin").mkdir(parents=True, exist_ok=True)
    (stage_dir / "share").mkdir(parents=True, exist_ok=True)
    (stage_dir / "licenses").mkdir(parents=True, exist_ok=True)

    shutil.copy2(app_bin, stage_dir / "bin" / "ideagittool-desktop")
    shutil.copy2(desktop_file, stage_dir / "share" / desktop_file.name)
    shutil.copy2(icon_file, stage_dir / "share" / "ideagittool.png")
    shutil.copy2(install_sh, stage_dir / "install.sh")
    shutil.copy2(uninstall_sh, stage_dir / "uninstall.sh")
    shutil.copy2(ROOT_DIR / "LICENSE", stage_dir / "LICENSE")
    shutil.copy2(ROOT_DIR / "NOTICE", stage_dir / "NOTICE")
    shutil.copy2(ROOT_DIR / "licenses" / "UPSTREAM_LICENSE.txt", stage_dir / "licenses" / "UPSTREAM_LICENSE.txt")

    launcher = stage_dir / "IdeaGitTool"
    launcher.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n'
        'exec "${HERE}/bin/ideagittool-desktop" "$@"\n',
        encoding="utf-8",
    )

    for exe in [launcher, stage_dir / "bin" / "ideagittool-desktop", stage_dir / "install.sh", stage_dir / "uninstall.sh"]:
        exe.chmod(0o755)

    with tarfile.open(tar_path, "w:gz") as tf:
        tf.add(stage_dir, arcname=pkg_name)

    sha = hashlib.sha256(tar_path.read_bytes()).hexdigest()
    (RELEASE_DIR / f"{tar_path.name}.sha256").write_text(f"{sha}  {tar_path.name}\n", encoding="utf-8")

    size_mb = tar_path.stat().st_size / 1024 / 1024
    print(f"[OK] Created {tar_path} ({size_mb:.1f} MB, sha256={sha[:12]}...)")


if __name__ == "__main__":
    main()
