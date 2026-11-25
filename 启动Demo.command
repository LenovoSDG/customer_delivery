#!/bin/bash
cd "$(dirname "$0")"
echo "Local Delivery Review Demo"
echo "Browser: http://127.0.0.1:4174"
echo "首次使用微信窗口监测前：系统设置 → 隐私与安全性 → 屏幕录制，勾选运行本 Demo 的终端并重新打开本窗口。"
echo "关闭本窗口即停止本地服务。"
open "http://127.0.0.1:4174"
node server.js
