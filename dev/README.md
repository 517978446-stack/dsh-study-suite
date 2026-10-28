# 开发与维护脚本

普通用户不需要这个目录。

| 文件 | 用途 |
|---|---|
| `backup.ps1` | Windows 数据备份：笔记、登录态、待办、课表 |
| `check-encoding.py` | 检查 `.ps1` 是否带 BOM、`.cmd/.vbs` 是否为 CRLF，同时扫描 `packages/*.zip` |

## 为什么需要 check-encoding

Windows 上有两个反复出现的坑：

1. **`.ps1` 没有 UTF-8 BOM** → PowerShell 5.1 按系统代码页（简中=GBK）解码，中文注释和字符串的字节被拆坏，`param()` 直接报语法错，而且报错行号指向看起来完全无辜的位置。
2. **`.cmd` / `.vbs` 是 LF 行尾** → `cmd.exe` 逐行解析时会把下一行吞进上一条命令，导致 `set PYTHONPATH` 之类的语句失效，服务起来却 `ModuleNotFoundError`。

`dev/check-encoding.py` 同时检查仓库里的脚本和 `packages/*.zip` 里的脚本 —— 后者才是真正到用户手里的东西。CI 在每次 push 时跑一遍（`.github/workflows/check.yml`）。

## 打包流程

```bash
# 1. 改版本号（三处 package.json + client.js 里的 vX.Y.Z）
# 2. 更新 CHANGELOG.md
# 3. 重新打 zip 到 dist/
# 4. 校验
python3 dev/check-encoding.py .
# 5. 提交 + 打 tag（会触发 release workflow 把 zip 传成 Release 资产）
git add -A && git commit -m "release: X.Y.Z" && git tag vX.Y.Z && git push origin main --tags
```
