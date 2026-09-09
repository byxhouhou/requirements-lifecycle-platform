#!/usr/bin/env python3
"""Build the portable instruction text and a team ZIP. Python 3.10+, stdlib only."""
from __future__ import annotations

import argparse
import hashlib
import re
from pathlib import Path
from urllib.parse import unquote
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
NAME = "cockpit-requirements-analysis"
RUNTIME_FILES = [
    "SKILL.md",
    "references/automotive-analysis.md",
    "references/image-handling.md",
    "references/review-and-baseline.md",
    "assets/project-intake.md",
    "assets/image-transcription.md",
    "assets/review-pack.md",
    "assets/baseline-and-template-mapping.md",
]
SOURCE_FILES = RUNTIME_FILES + [
    "VERSION", "agents/openai.yaml", "README.md", "SOP.md",
    "examples/review-example.md", "examples/smoke-cases.md",
    "scripts/package_skill.py", "VALIDATION.md",
]
PORTABLE = "portable/SKILL_FULL.txt"


def local_file(relative: str) -> Path:
    candidate = ROOT / relative
    if not candidate.resolve().is_relative_to(ROOT):
        raise ValueError(f"Path escapes skill directory: {relative}")
    if candidate.is_symlink():
        raise ValueError(f"Symlink is not a package source: {relative}")
    return candidate


def load_sources() -> dict[str, str]:
    sources = {}
    for relative in SOURCE_FILES:
        path = local_file(relative)
        if not path.is_file():
            raise ValueError(f"Required source missing: {relative}")
        sources[relative] = path.read_text(encoding="utf-8-sig")
    return sources


def validate(sources: dict[str, str]) -> str:
    version = sources["VERSION"].strip()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("VERSION must be a three-part numeric version.")
    front = re.match(r"^---\n(.*?)\n---", sources["SKILL.md"], re.S)
    if not front or f"name: {NAME}" not in front.group(1):
        raise ValueError("SKILL.md frontmatter name is missing or inconsistent.")
    if f'version: "{version}"' not in front.group(1):
        raise ValueError("SKILL.md metadata version differs from VERSION.")
    for relative in ["README.md", "SOP.md", *RUNTIME_FILES[4:]]:
        # The image form is independent of the package release number.
        if relative.endswith("image-transcription.md"):
            continue
        if version not in sources[relative]:
            raise ValueError(f"Package version absent from {relative}.")
    for relative, content in sources.items():
        if not relative.endswith(".md"):
            continue
        if "\ufffd" in content:
            raise ValueError(f"Replacement character found in {relative}.")
        for raw in re.findall(r"\[[^\]\n]+\]\(([^)\n]+)\)", content):
            target = raw.strip().strip("<>")
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith("#"):
                continue
            target = unquote(target.split("#", 1)[0])
            path = (ROOT / relative).parent / target
            if not path.resolve().is_relative_to(ROOT):
                raise ValueError(f"Link escapes skill: {relative} -> {target}")
            normalized = path.resolve().relative_to(ROOT).as_posix()
            if normalized == PORTABLE:
                continue
            if normalized not in sources:
                raise ValueError(f"Link missing from package: {relative} -> {target}")
    return version


def make_portable(sources: dict[str, str], version: str) -> bytes:
    intro = (
        f"车载智能座舱系统需求分析 Skill {version} — 纯文本合并版\n\n"
        "本文件已内嵌 SKILL.md、全部分析规则和空白表单。文中相对路径指向下面"
        "同名的“BEGIN FILE”区块；无需访问本机文件。按当前阶段使用对应内容。\n"
        "示例、表单空白和参考链接不属于客户要求或人工决定。请在接收实际项目"
        "资料后开始分析。此文本不提供识图能力。客户原文、图片转写和决定记录"
        "须另行提供，且须处于模型可访问的上下文内。\n"
        "这是从源文件自动生成的副本；维护源文件后重新打包，不直接修改此文件。\n"
    )
    sections = [intro]
    for relative in RUNTIME_FILES:
        sections.append(
            f"\n===== BEGIN FILE: {relative} =====\n"
            f"{sources[relative].rstrip()}\n"
            f"===== END FILE: {relative} =====\n"
        )
    sections.append(
        "\n===== 团队文档说明 =====\n"
        "SKILL.md 提到的 SOP.md 是给人员阅读的操作文件，包含在团队 ZIP 中；"
        "它不是模型执行所必需的缺失指令。运行所需规则和表单已全部内嵌。\n"
    )
    return "".join(sections).encode("utf-8")


def build(output_dir: Path) -> tuple[Path, Path, Path, int]:
    sources = load_sources()
    version = validate(sources)
    portable = local_file(PORTABLE)
    portable.parent.mkdir(parents=True, exist_ok=True)
    portable_bytes = make_portable(sources, version)
    portable.write_bytes(portable_bytes)
    output_dir = output_dir.resolve()
    if output_dir == ROOT:
        raise ValueError("Choose an output subdirectory or a separate release directory.")
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / f"{NAME}-v{version}.zip"
    checksums = output_dir / f"{NAME}-v{version}.sha256"
    for path in (archive, checksums):
        if path.is_symlink():
            raise ValueError(f"Refusing to overwrite a symlink: {path}")
    payloads = {
        relative: sources[relative].encode("utf-8")
        for relative in SOURCE_FILES
    }
    payloads[PORTABLE] = portable_bytes
    with ZipFile(archive, "w", compression=ZIP_DEFLATED) as bundle:
        for relative, data in payloads.items():
            bundle.writestr(f"{NAME}/{relative}", data)
    with ZipFile(archive) as bundle:
        if bundle.testzip() is not None:
            raise ValueError("ZIP integrity check failed.")
        for relative, data in payloads.items():
            if bundle.read(f"{NAME}/{relative}") != data:
                raise ValueError(f"ZIP round-trip mismatch: {relative}")
    lines = [f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}"]
    lines += [
        f"{hashlib.sha256(data).hexdigest()}  {NAME}/{relative}"
        for relative, data in payloads.items()
    ]
    checksums.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return archive, checksums, portable, len(payloads)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    archive, checksums, portable, count = build(args.output_dir)
    print(f"Validated sources and local links; packaged {count} files.")
    print(f"ZIP: {archive}")
    print(f"SHA256: {checksums}")
    print(f"Portable text: {portable} ({portable.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
