# 智汇 Windows 桌面端 1.14

## 开发运行

使用 Windows x64、Node.js 和 npm。随 1.14 桌面包验证的 Node.js 版本为 26.13.0。在本目录打开 PowerShell，执行：

```powershell
npm.cmd ci --omit=optional
$env:APP_DATA_DIR = Join-Path $env:LOCALAPPDATA 'ZhiHuiDev'
npm.cmd start
```

打开 http://127.0.0.1:4174 。首次使用在「模型设置」选择本机 Ollama 或填入自己的 API 配置。仅开发界面、项目管理、文本分析时可跳过语音权重下载。默认 JSON 存储在 APP_DATA_DIR 中；设置 DATABASE_URL 可启用项目状态的 PostgreSQL 存储，截图仍保存在本机。

## 本地语音模型

在本目录运行下面的命令下载多语言 Whisper Base Q5_1。也可以从已经安装的智汇 1.14 程序目录复制 whisper-model.bin 到本目录，核对相同的 SHA256。

```powershell
curl.exe -fL "https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-base-q5_1.bin" -o whisper-model.bin
(Get-FileHash .\whisper-model.bin -Algorithm SHA256).Hash
```

预期 SHA256 为 422F1AE452ADE6F30A004D7E5C6A43195E4433BC370BF23FAC9CC591F01A8898。Windows CPU 语音运行库已列入 package.json。测试 OCR 视觉复核需要本机 Ollama 安装 qwen3-vl:4b。

## 代码入口

- index.html、style.css、app.js 为工作台界面；server.js 提供 HTTP 接口。
- capture-queue.js、ocr.js、ocr.ps1 负责截图队列和 OCR。
- model-provider.js 处理 API 和本地模型路由；whisper-local.js 负责本地转写。
- rehearsal-ui.js、rehearsal.js、speech-engine.js 和 audio-capture-worklet.js 负责演练。
- delivery-knowledge.js 是交付质检和汇报追问共用的知识库。
- windows/Desk.cs 与 windows/Setup.cs 是桌面启动器和安装器源码。开发时用 npm start。发布用的 node.exe、模型和安装包单独分发。

演练模块基于 LenovoSDG/customer_delivery 提交 b4be98acc08e97a03dde5bda753c0a0443d9ecf0。协作时保留原仓库提交历史及其已有测试。
