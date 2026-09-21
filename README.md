<div align="center">
  <h1>ESP Rowing Monitor WebGUI</h1>
  <p><strong>A clear, browser-based view of every stroke.</strong></p>
  <p>
    Connect to ESP Rowing Monitor, watch live rowing metrics, review sessions, update firmware, and export your data from an installable Progressive Web App.
  </p>
  <p>
    <a href="https://esp-rowing-monitor-webgui.edgeone.dev/"><img src="https://img.shields.io/badge/Live%20demo-Open%20EdgeOne-0b78d0?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Open the live EdgeOne demo"></a>
    <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/中文-README-1f2937?style=for-the-badge" alt="Read the Chinese README"></a>
  </p>
</div>

## Live demo

Open the hosted app at **[esp-rowing-monitor-webgui.edgeone.dev](https://esp-rowing-monitor-webgui.edgeone.dev/)**.

The public EdgeOne deployment is built from this repository's <code>master</code> branch. A push to <code>master</code> triggers the configured build and publishes the new version automatically.

<p align="center">
  <img src="./docs/imgs/ESP-Rowing-Monitor-WebGUI.jpg" width="100%" alt="ESP Rowing Monitor live dashboard with rowing metrics and force curve">
</p>

## What this project does

ESP Rowing Monitor WebGUI is an installable PWA for [ESP Rowing Monitor](https://github.com/Abasz/ESPRowingMonitor). It turns the device's rowing data into a live dashboard, a local training logbook, session analysis views, firmware tools, and portable exports.

The hosted app is served over HTTPS so browser capabilities such as Web Bluetooth and WebUSB can work in a secure context. The interface can also be installed from a supported browser and used offline after its assets are available.

## Features

| Area | What you can do |
| --- | --- |
| Live dashboard | See distance, pace, power, stroke rate, timer, drag factor, drive/recovery time, meters per stroke, and total strokes as they arrive. Configure units, cards, layouts, orientation behavior, and moving-average smoothing. |
| Session control | Start, pause, resume, and stop sessions manually, or enable auto-start when a new stroke is detected. |
| Logbook | Keep recorded sessions in the browser's local IndexedDB storage, browse session metadata, and open a session without leaving the logbook. |
| Analysis | Inspect summary metrics, time-series charts, laps, force curves, and per-stroke details in a dedicated session view. |
| Export and import | Export FIT, CSV, and JSON data for backup or analysis, import JSON sessions, share files when the browser supports it, and export rowing settings as a C++ header. |
| Firmware updates | Download release profiles, choose a supported hardware profile, and perform an over-the-air firmware update from the browser. |
| Heart-rate sensors | Pair BLE heart-rate monitors through Web Bluetooth or use an ANT+ monitor through WebUSB. |

<p align="center">
  <img src="./docs/imgs/ESP-Rowing-Monitor-WebGUI-logbook.jpg" width="49%" alt="ESP Rowing Monitor session logbook">
  <img src="./docs/imgs/ESP-Rowing-Monitor-WebGUI-session-analysis.jpg" width="49%" alt="ESP Rowing Monitor session analysis with charts">
</p>

## Use the hosted app

1. Open the [live demo](https://esp-rowing-monitor-webgui.edgeone.dev/) in a supported browser.
2. Use Chrome on Windows or Android for the most complete Web Bluetooth experience.
3. Connect your ESP Rowing Monitor from the app toolbar.
4. Start a session and use the dashboard, logbook, and analysis views as your workout progresses.

The app is designed for firmware with the Extended BLE Metrics API, which is available in ESP Rowing Monitor firmware **5.2.0 or newer**.

## Local development

~~~bash
git clone https://github.com/2452937652/ESPRowingMonitor-WebGUI.git
cd ESPRowingMonitor-WebGUI
npm install
npm start
~~~

Create a production build with:

~~~bash
npm run build
~~~

The build preparation step retrieves the current firmware assets and rowing profiles used by the firmware update flow, so network access is required for a fresh build.

## Browser and device compatibility

- Chrome on Windows and Android is the primary tested environment.
- iOS browsers do not expose Web Bluetooth. On iOS, a browser such as [Bluefy](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055) is required.
- macOS Web Bluetooth support depends on the browser and platform and has received limited testing.
- Some Chrome installations may need <code>chrome://flags/#enable-web-bluetooth-new-permissions-backend</code> for reconnect behavior.
- For ANT+ on Windows, the USB dongle needs a WinUSB-compatible driver. [Zadig](https://zadig.akeo.ie/) can install the driver.
- The GitHub Pages workflow does not support the deprecated WebSocket-based workflow. Historical instructions remain in [docs/deprecated-docs.md](docs/deprecated-docs.md).

## Data storage

Sessions are stored locally in the browser with IndexedDB. This keeps the logbook fast and offline-capable, but it is not cloud synchronization. The app requests persistent storage when the browser supports it; browser and operating-system policies can still evict local data.

Export your database regularly from the logbook to keep a portable backup.

## Project links

- **Live app:** [esp-rowing-monitor-webgui.edgeone.dev](https://esp-rowing-monitor-webgui.edgeone.dev/)
- **This repository:** [github.com/2452937652/ESPRowingMonitor-WebGUI](https://github.com/2452937652/ESPRowingMonitor-WebGUI)
- **Upstream ESP Rowing Monitor:** [github.com/Abasz/ESPRowingMonitor](https://github.com/Abasz/ESPRowingMonitor)
- **Upstream WebGUI:** [github.com/Abasz/ESPRowingMonitor-WebGUI](https://github.com/Abasz/ESPRowingMonitor-WebGUI)

[简体中文](README.zh-CN.md) · [English](README.md)
