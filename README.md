# 智汇 Windows 桌面端 1.14

## 开发运行

使用 Windows x64、Node.js 和 npm。随 1.14 桌面包验证的 Node.js 版本为 26.13.0。在本目录打开 PowerShell，执行：

```powershell
npm.cmd ci --include=optional
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


## 体验与开发验收

- 主流程：导入沟通材料后自动整理需求，核对来源后确认，再上传交付材料、运行检查与汇报演练。
- 演示项目独立创建，不覆盖已有项目。移除支持撤销，撤回需求确认会保留交付任务及材料。
- 项目规范、回答草稿和报告自动保存；读取失败时暂停写入并提供重试。演练对话与反馈刷新后可恢复，录音不会自动恢复。
- 模型来源只分本地和自定义 API。模型列表读取、连接测试均不保存草稿设置；保存设置后才切换。
- 仅可读文档参与文字质检。模型失败、截断或无有效内容时保留上次报告，不将材料标为已检查。
- Windows 截图与监测功能保留，在其他平台隐藏入口。Windows 本地语音需安装可选依赖和模型。Apple Silicon 若已安装 `.venv-asr` 与 `voice-models/whisper-turbo-q4`，自动使用已有的本机高精度识别；未安装时提供文字演练，不会自动转发音频到云端。

```sh
npm ci --include=optional
npm test
npm run test:core-legacy
```

`npm test` 检验当前 1.14 项目流程、模型路由、演练和本机识别输入边界。`test:core-legacy` 单独检验保留的旧版质检/网关模块。仓库原有的 `project-list`、`report-ui`、`model-settings` 等 UI 测试针对旧版主分支结构，当前版本新增 `experience.test.js` 验证实际加载的应用入口。

本次验收记录见 [体验审查与验收](docs/experience-review.md)。
