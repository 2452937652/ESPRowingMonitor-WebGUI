# 划船机 WebGUI 2.0 独立部署

源代码分支：`codex/rowing-webgui-2`。从用户仓库 master 的 `ddadc4c` 建立；没有修改 master 或 EdgeOne 旧版配置。

生产目标：Cloudflare Worker `rowing-monitor-v2`，独立域名 `rowing-v2.noctis.uno`。
旧版：`https://esp-rowing-monitor-webgui.edgeone.dev/`。
导航页：`https://start.noctis.uno/`，单独保留两个入口。

构建：`npm ci`，`npm run build:worker`。
产物：`deploy/generated/worker.mjs`，包含本次 Angular 静态构建的 gzip 资源。
使用 Cloudflare Worker multipart 上传该 ES module，并设置 `main_module: worker.mjs`、`compatibility_date: 2026-11-09`、启用日志与 traces。

2.0 复用原项目 BLE V2 解码、设备设置、训练记录、分析与导出逻辑。增加独立的大曲线首页、完整桨快照比较、距离/时间轴、峰值位置、距离积分平均力与指标选择。
演示数据仅存在于新曲线组件内，不送入会话记录器；设备连接时自动结束演示。

新旧网站使用不同 origin，浏览器权限、PWA 缓存、设置和训练记录互相独立；历史记录可用原有 JSON 导入导出功能迁移。
网页升级不改变设备固件或 EEPROM/NVS 配置。

主机单元验证：`npx vitest run src/app/dashboard/force-console/force-curve-history.spec.ts`。
构建校验：`npx ng build --configuration production`。
