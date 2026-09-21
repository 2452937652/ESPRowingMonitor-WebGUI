<div align="center">
  <h1>ESP Rowing Monitor WebGUI</h1>
  <p><strong>在浏览器里看清每一次划桨。</strong></p>
  <p>
    连接 ESP Rowing Monitor，实时查看划船数据，记录和分析训练，更新固件并导出数据。
  </p>
  <p>
    <a href="https://esp-rowing-monitor-webgui.edgeone.dev/"><img src="https://img.shields.io/badge/公网体验-打开%20EdgeOne-0b78d0?style=for-the-badge&logo=googlechrome&logoColor=white" alt="打开 EdgeOne 公网体验"></a>
    <a href="README.md"><img src="https://img.shields.io/badge/English-README-1f2937?style=for-the-badge" alt="Read the English README"></a>
  </p>
</div>

## 公网体验

打开 **[esp-rowing-monitor-webgui.edgeone.dev](https://esp-rowing-monitor-webgui.edgeone.dev/)** 使用在线版本。

EdgeOne 公网部署跟随本仓库的 <code>master</code> 分支。向 <code>master</code> 推送提交后，会自动执行构建并发布新版本，无需手动在 EdgeOne 控制台重新部署。

<p align="center">
  <img src="./docs/imgs/ESP-Rowing-Monitor-WebGUI.jpg" width="100%" alt="ESP Rowing Monitor 实时仪表盘，展示划船指标和力量曲线">
</p>

## 项目简介

ESP Rowing Monitor WebGUI 是为 [ESP Rowing Monitor](https://github.com/Abasz/ESPRowingMonitor) 提供的可安装 PWA。它把设备采集到的划船数据呈现为实时仪表盘，并提供本地训练日志、训练分析、固件工具以及数据导入导出功能。

在线版本通过 HTTPS 提供服务，使 Web Bluetooth 和 WebUSB 等浏览器能力处于安全上下文中。支持的浏览器可以安装这个 PWA；资源缓存完成后，也可以在离线状态下打开应用。

## 功能

| 模块 | 能做什么 |
| --- | --- |
| 实时仪表盘 | 查看距离、配速、功率、划频、计时器、阻力因子、驱动/恢复时间、每桨距离和总桨数；支持单位、卡片、布局、屏幕方向和移动平均平滑设置。 |
| 训练控制 | 手动开始、暂停、继续和结束训练，也可以在检测到新一桨时自动开始。 |
| 训练日志 | 使用浏览器本地 IndexedDB 保存训练记录，查看记录摘要，并直接打开训练详情。 |
| 训练分析 | 在独立详情页查看汇总指标、时间序列图表、分段、力量曲线和逐桨数据。 |
| 导入导出 | 导出 FIT、CSV 和 JSON，用于备份或分析；导入 JSON 训练记录；在浏览器支持时调用系统分享；把划船设置导出为 C++ 头文件。 |
| 固件更新 | 下载版本配置文件，选择支持的硬件配置，并直接在浏览器中进行 OTA 固件更新。 |
| 心率设备 | 通过 Web Bluetooth 连接 BLE 心率带，也可以通过 WebUSB 使用 ANT+ 心率设备。 |

<p align="center">
  <img src="./docs/imgs/ESP-Rowing-Monitor-WebGUI-logbook.jpg" width="49%" alt="ESP Rowing Monitor 训练日志">
  <img src="./docs/imgs/ESP-Rowing-Monitor-WebGUI-session-analysis.jpg" width="49%" alt="ESP Rowing Monitor 训练分析图表">
</p>

## 使用在线版本

1. 在支持的浏览器中打开[公网版本](https://esp-rowing-monitor-webgui.edgeone.dev/)。
2. 为获得完整的 Web Bluetooth 体验，优先使用 Windows 或 Android 上的 Chrome。
3. 在应用顶部工具栏连接 ESP Rowing Monitor。
4. 开始训练，按需使用仪表盘、日志和分析页面。

应用面向带有 Extended BLE Metrics API 的固件，ESP Rowing Monitor 固件需要 **5.2.0 或更高版本**。

## 本地开发

~~~bash
git clone https://github.com/2452937652/ESPRowingMonitor-WebGUI.git
cd ESPRowingMonitor-WebGUI
npm install
npm start
~~~

创建生产构建：

~~~bash
npm run build
~~~

构建准备步骤会获取固件更新流程使用的最新固件资源和划船配置文件，因此首次构建需要网络连接。

## 浏览器和设备兼容性

- Windows 和 Android 上的 Chrome 是主要测试环境。
- iOS 浏览器不提供 Web Bluetooth；在 iOS 上需要使用 [Bluefy](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055) 等支持 Web Bluetooth 的浏览器。
- macOS 的 Web Bluetooth 能力取决于浏览器和系统，当前测试范围有限。
- 某些 Chrome 安装需要开启 <code>chrome://flags/#enable-web-bluetooth-new-permissions-backend</code> 才能正常重连设备。
- Windows 上使用 ANT+ 时，USB 接收器需要 WinUSB 兼容驱动，可使用 [Zadig](https://zadig.akeo.ie/) 安装。
- GitHub Pages 工作流不支持已废弃的 WebSocket 工作流；旧版手动部署说明保留在 [docs/deprecated-docs.md](docs/deprecated-docs.md)。

## 数据存储

训练记录保存在浏览器本地 IndexedDB 中，速度快并支持离线使用，但不会自动同步到云端。浏览器支持时，应用会请求持久化存储；浏览器和操作系统策略仍可能清理本地数据。

请定期从训练日志导出数据库，保留可迁移的备份。

## 项目链接

- **公网应用：** [esp-rowing-monitor-webgui.edgeone.dev](https://esp-rowing-monitor-webgui.edgeone.dev/)
- **本仓库：** [github.com/2452937652/ESPRowingMonitor-WebGUI](https://github.com/2452937652/ESPRowingMonitor-WebGUI)
- **上游 ESP Rowing Monitor：** [github.com/Abasz/ESPRowingMonitor](https://github.com/Abasz/ESPRowingMonitor)
- **上游 WebGUI：** [github.com/Abasz/ESPRowingMonitor-WebGUI](https://github.com/Abasz/ESPRowingMonitor-WebGUI)

[English](README.md) · [简体中文](README.zh-CN.md)
