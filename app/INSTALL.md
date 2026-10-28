# 学习助手 · 安装说明

装进 DeepSeek Harness 的本地学习面板：课程、英中互译、语音纪要、AI 率自查。

**你手上应该有**：这个压缩包（里面有服务、安装脚本、自检脚本）。
面板代码是公开的，下面第一步会给你地址。

**前置条件**：Windows 10+ 或 macOS 13+ ｜ Python 3.9 以上 ｜ 磁盘最少 1GB（最小安装）

---

## 第 1 步：装本地服务

### Windows

解压本压缩包，在 `study-suite` 文件夹里按住 **Shift + 右键** →「在此处打开 PowerShell」，执行：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

想连语音识别一起装（约 5GB）：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Full
```

> 提示找不到 Python：去 <https://www.python.org/downloads/> 下载安装，**装的时候勾选 Add to PATH**。

### macOS

解压后在该目录执行：

```bash
./install.sh          # 约 200MB：翻译 + 文本检测
./install.sh --full   # 约 5GB：再加语音识别、说话人分离、7B 精准翻译
```

脚本会自动完成：建目录 → 装依赖 → 下模型 → 注册开机自启。

**装完先确认服务活着**：浏览器打开 <http://127.0.0.1:8791/health>，能看到一串 JSON 就对了。

---

## 第 2 步：装面板

### 方式 A（推荐，最稳）

1. 下载 <https://github.com/517978446-stack/dsh-study-suite/archive/refs/heads/main.zip>
2. 解压，得到 `dsh-study-suite-main` 文件夹
3. 打开 DeepSeek Harness → **设置 → 插件 → 从文件夹安装** → 选这个文件夹

### 方式 B（界面支持输入来源时）

在插件页的安装入口直接填：

```
github:517978446-stack/dsh-study-suite
```

> 不确定你的版本界面是否支持手输地址。没有这个入口就用方式 A。

装好后侧栏出现「学习助手」图标，点开有四个标签：**课程 / 翻译 / 检测**（语音是翻译页里的子标签）。

---

## Windows 装之前：先跑预检

打包里有个 **`check-win.ps1`**，只做检查、不改系统：

```powershell
powershell -ExecutionPolicy Bypass -File check-win.ps1
```

> **别用记事本改这些 .ps1 文件**：它们保存为「UTF-8 带 BOM」，记事本另存可能把 BOM 去掉，中文 Windows 的 PowerShell 5.1 就会把中文按 GBK 解码，报一堆语法错误。

它会告诉你：Windows 版本、Python 有没有、pip 可用吗、能不能连 PyPI 和模型站、Edge 在不在、8791 端口占用没。有 `[MISS]` 就先解决再装。

### 解码线程（性能）

安装时按 CPU 核数自动定：**半核数，最多 8 个**。

| 核数 | 线程 |
|---|---|
| 24 | 8 |
| 10 | 5 |
| 8 | 4 |

实测按核数全开反而更慢（24 核开 24 线程比 8 线程慢 38%），所以封顶。要手动改，安装前设置环境变量：

```bash
CN_MT_THREADS=6 ./install.sh
```

```powershell
$env:CN_MT_THREADS=6; powershell -ExecutionPolicy Bypass -File install.ps1
```

### 装完最快的验证

```powershell
python "%USERPROFILE%\.dsh-study-suite\smoke.py"
```

12 项接口检查，几秒钟出结果。比 `doctor.ps1` 轻（doctor 查环境，smoke 查功能）。

## 第 3 步：自检（出问题先跑这个）

| 平台 | 命令 |
|---|---|
| Windows | 右键 `doctor.ps1` → 使用 PowerShell 运行 |
| macOS | 双击 `doctor.command` |

它会检查依赖、模型、服务进程、端口、翻译与检测功能、CORS，最后给一句结论。
**有问题把整段输出发我** —— 里面只有版本号、路径和报错，没有你的账号信息。

---

## 能用到什么程度

| 功能 | macOS | Windows |
|---|---|---|
| 翻译（中英对照） | ✅ | ✅ |
| AI 率检测（文本 / Word / 文字版 PDF） | ✅ | ✅ |
| 图片、扫描版 PDF | ✅ | ❌ 需另装 OCR 组件 |
| 语音转写 | ✅ | ⚠️ 需 `-Full`；首次使用自动下载模型 |
| 说话人 A/B 分离 | ✅ | ❌ Windows 未打包该模型 |
| 精准翻译 7B | ✅ | ❌ 只能用「快速」引擎（术语表也只在 7B 下参与翻译） |
| 课程动态 | ✅ 需你自己的 CN 登录 | ✅ 同左 |

### 关于 AI 率检测（必须说清）

本地启发式估算，**不是** Turnitin / GPTZero 的判定结果。
分数仅供自查，不能作为学术不端证据，也不能用于申诉。请以学校官方检测为准。
面板里也写了同样的免责声明。

---

## 两个常见卡点

**面板显示"连不上本地服务"**
服务没起来。跑一遍自检脚本看日志；macOS 日志在 `~/.dsh-study-suite/service.log`。

**翻译很慢**
精准模式首次要加载 7B 模型约 2 秒，空闲 5 分钟自动卸载省内存。日常建议用「快速」。

---

## 卸载

| 平台 | 命令 |
|---|---|
| Windows | `powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall` |
| macOS | `./install.sh --uninstall` |

面板：DeepSeek Harness → 设置 → 插件 → 卸载「学习助手」。


---

### Windows 的服务是“无窗口”运行的

安装脚本用 `pythonw.exe` 起服务，日志写到 `%USERPROFILE%\.dsh-study-suite\service.log`。

原因：如果带着控制台窗口跑，那个最小化的黑窗口**被人关掉一次，服务就整个消失**——Intel Fortran/MKL 在控制台收到 CLOSE 事件时会直接 abort 进程，连 traceback 都不留。

对应的文件：

```
run-service.cmd      真正干活：设环境变量、跑 pythonw、日志重定向
Startup\study-suite.vbs   开机时静默调用上面那个（不弹黑窗）
service.log          日志
```

出事第一件事是看 `service.log`。

## Windows 实测情况（诚实说明）

我只在 macOS 上开发和运行，**没有真机跑过 Windows**。已经做完的验证：

| 项目 | 结论 |
|---|---|
| 依赖轮子 | 已验证：`ctranslate2`、`sentencepiece`、`pypdf`、`python-docx`、`faster-whisper`、`sherpa-onnx` 在 win_amd64 上都有官轮（Python 3.12 / 3.13 / 3.14 都查过） |
| 模型下载 | Argos 的 `.argosmodel` 就是 zip，脚本会改名成 `.zip` 再解压，解压后结构已核对 |
| PDF 导出 | Windows 上找 Edge/Chrome 的多个常见路径；打印参数会在 `--headless=new` 失败时回退 `--headless` |
| 7B 精准翻译 | **不可用**（MLX 只有 macOS），会自动退回快速引擎 |
| 图片 / 扫描件 OCR | **不可用**（依赖 macOS 系统能力） |
| 说话人分离 | **不可用**（模型没打包进 Windows 版） |

如果安装失败，让朋友跑 `doctor.ps1` 把输出发我，里面只有版本号、路径和报错。
