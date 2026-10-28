#!/usr/bin/env python3
"""把打包用的插件目录改成「本地插件」形态，并写入平台版本号。

    python3 dev/set-plugin-version.py <plugin目录> <版本号>

做三件事：
  1. package.json：改名 @local/study-suite、去掉发布相关字段、写入版本
  2. cordis.patch.yml：插件 id 换成 @local/study-suite
  3. client.js：面板角落里显示的版本标签换成这个平台的版本
"""
import json
import pathlib
import re
import sys


def main():
    if len(sys.argv) < 3:
        print("用法: set-plugin-version.py <plugin目录> <版本号>")
        return 2
    plugin = pathlib.Path(sys.argv[1])
    version = sys.argv[2].lstrip("v")

    meta_path = plugin / "package.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.update(name="@local/study-suite", private=True, version=version)
    for key in ("license", "author", "keywords", "repository", "bugs", "homepage", "publishConfig"):
        meta.pop(key, None)
    with open(meta_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")

    patch_path = plugin / "cordis.patch.yml"
    if patch_path.exists():
        text = patch_path.read_text(encoding="utf-8").replace("'dsh-study-suite'", "'@local/study-suite'")
        with open(patch_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)

    client_path = plugin / "client.js"
    client = client_path.read_text(encoding="utf-8")
    client = re.sub(r"'v\d+\.\d+\.\d+'", "'v%s'" % version, client)
    with open(client_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(client)
    return 0


if __name__ == "__main__":
    sys.exit(main())
