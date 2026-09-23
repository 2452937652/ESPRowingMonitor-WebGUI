# ESP Rowing Monitor 六磁铁 WebGUI

这是基于官方 v7.2.0 重构的个人 WebGUI，服务于 ESP32-S3 N16R8、GPIO16 霍尔传感器和六磁铁飞轮。[EdgeOne 在线版本](https://esp-rowing-monitor-webgui.edgeone.dev/)从本仓库 `master` 分支构建。

本版增加独立的 Force Curve V2 BLE 服务、按连接 epoch 和 strokeId 对齐的会话记录、带物理距离和时间坐标的力曲线、趋势图、中文界面，以及对旧版数据库的无损升级。旧固件仍可使用原有 BLE 数据通道；V2 数据只在设备提供对应服务时启用。

## 构建与升级

使用 Node.js 安装依赖后运行 `npm ci`、`npm run build`。EdgeOne 使用仓库根目录 `edgeone.json`，产物目录是 `dist/esp-rowing-monitor-client/browser`。构建时官方脚本会下载官方 v7.2.0 固件资源；这些资源不包含本机的六磁铁定制固件。本机固件应通过 VS Code + PlatformIO 的 `genericAir6-esp32s3-n16r8-debug` 环境普通上传，保留 NVS；不要在 WebGUI 的官方固件列表中选择其他硬件包替代它。

部署前保存当前 `master` 提交 SHA。新版本经独立分支和 PR 合入 `master` 后触发 EdgeOne 构建。若需要回退网页，将 `master` 恢复到部署前提交并等待 EdgeOne 重建；浏览器已有的训练数据先导出 JSON 备份，再切换版本。设备固件有独立的 golden 六磁铁基线，网页回退不改变设备固件或 NVS。

编译和自动测试不等同于实际划船验收。连接稳定性、20/90/150/超过 200 cm 的行程、BLE 分包、历史曲线和显示效果仍需在设备上实划核验。
