# dev/ —— 只给改代码的人用

这个目录里的东西**普通用户不需要**，也不打进 `packages/*.zip`。

## 文件

| 文件 | 用途 |
|---|---|
| `backup.ps1` | Windows 学习数据备份（默认不含登录态） |
| `check-encoding.py` | 检查 `.ps1` 是否带 BOM、`.cmd/.vbs` 是否为 CRLF；同时扫描 `packages/*.zip` |

## backup.ps1

```powershell
# 备份到今天日期的 zip（默认不含 secrets/）
powershell -ExecutionPolicy Bypass -File dev\backup.ps1

# 指定目标目录 + 保留 30 份
powershell -ExecutionPolicy Bypass -File dev\backup.ps1 -Dest "D:\backup" -Keep 30

# 连登录态一起备份（会警告：cn-state.json 是明文 cookie）
powershell -ExecutionPolicy Bypass -File dev\backup.ps1 -IncludeSecrets
```

默认不备份 `secrets/`：`cn-state.json` 是明文登录 cookie，传到网盘等于把账号交出去。

注册成每天 21:00 的计划任务：

```powershell
schtasks /Create /TN "study-suite-backup" /SC DAILY /ST 21:00 ^
  /TR "powershell -ExecutionPolicy Bypass -File %USERPROFILE%\dsh-study-suite-repo\dev\backup.ps1" /F
```

## 为什么需要 check-encoding

Windows 上两个反复出现的坑：

1. **`.ps1` 没有 UTF-8 BOM** → PowerShell 5.1 按系统代码页（简中=GBK）解码，中文注释和字符串被拆坏，`param()` 报语法错，且报错行号指向完全无辜的位置。
2. **`.cmd` / `.vbs` 是 LF 行尾** → `cmd.exe` 逐行解析时会吞掉下一行，`set PYTHONPATH` 失效，服务起来却 `ModuleNotFoundError`。

检查器同时看仓库脚本和 `packages/*.zip` 里的脚本 —— 后者才是真正到用户手里的。CI 在每次 push 时跑（`.github/workflows/check.yml`）。

## 打包流程

```bash
# 1. 改版本号（三处 package.json + client.js 里的 vX.Y.Z）
# 2. 更新 CHANGELOG.md
# 3. 重新打 zip 到 dist/
# 4. 校验
python3 dev/check-encoding.py .
# 5. 提交 + 打 tag（触发 release workflow，自动建 Release 并上传 zip）
git add -A && git commit -m "release: X.Y.Z" && git tag vX.Y.Z && git push origin main --tags
```

## 发版流程（作者用）

```powershell
# 1. 解压新的安装包
Expand-Archive study-suite-windows-X.Y.Z.zip -DestinationPath .

# 2. 装
powershell -ExecutionPolicy Bypass -File study-suite\install.ps1

# 3. 验 —— 装完立刻跑，12 项接口全过才算发得出去
python "$env:USERPROFILE\.dsh-study-suite\smoke.py"
```

三步大概 2–3 分钟（依赖已装过会更快）。

macOS 对应的是：

```bash
./install.sh
python3 "$HOME/.dsh-study-suite/smoke.py"
```

### 为什么 smoke 要放进安装目录

`smoke.py` 原本只在解压出来的包里，用户装完删掉 zip 就找不到了。现在 `install.ps1` / `install.sh` 会把它一起拷到安装目录，所以上面第 3 步不需要回到解压目录。

### 发版前还要过的两道闸

1. `python3 dev/check-encoding.py .` —— `.ps1` 带 BOM、`.cmd/.vbs` 是 CRLF，并且扫描 `packages/*.zip`
2. 推 tag 后看 Actions：`release` 成功即自动建 Release 并上传两个 zip

