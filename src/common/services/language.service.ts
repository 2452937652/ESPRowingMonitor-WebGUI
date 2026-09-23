import { effect, Injectable, OnDestroy, signal, WritableSignal } from "@angular/core";

export type AppLanguage = "en" | "zh-CN";

@Injectable({
    providedIn: "root",
})
export class LanguageService implements OnDestroy {
    private static readonly STORAGE_KEY: string = "esprm.gui.language";

    readonly language: WritableSignal<AppLanguage> = signal<AppLanguage>(this.readLanguage());

    private readonly translations: Readonly<Record<string, string>> = {
        Settings: "设置",
        General: "常规",
        Display: "显示",
        Rowing: "划船机",
        "Export Profile": "导出配置",
        Export: "导出",
        Save: "保存",
        Cancel: "取消",
        "BLE Mode:": "BLE 模式：",
        "Heart Rate Monitor:": "心率监测：",
        "Auto Session:": "自动训练：",
        "Auto Lap:": "自动分段：",
        "Heart Rate Monitor": "心率监测",
        "Auto Session": "自动训练",
        "Auto Lap": "自动分段",
        Off: "关闭",
        "On Start": "开始时",
        "On Start & Pause": "开始并自动暂停",
        Distance: "距离",
        Time: "时间",
        Units: "单位",
        Metric: "公制",
        Imperial: "英制",
        Orientation: "方向",
        Auto: "自动",
        Landscape: "横屏",
        Portrait: "竖屏",
        "Trend style:": "趋势样式：",
        "Gradient bars": "渐变条",
        "Line + dots": "折线＋点",
        "Smooth area": "平滑面积",
        "Metrics Averaging": "指标平均",
        "Mode:": "模式：",
        Performance: "性能指标",
        All: "全部指标",
        "Window size:": "窗口大小：",
        "Dashboard Layout": "仪表盘布局",
        "Reset Layout": "重置布局",
        "Clear Layout": "清空布局",
        "Force Curve": "拉力曲线",
        "Anomalous drive": "异常驱动距离",
        "Sample Index": "采样序号",
        "Show Peak Force in Title": "在标题中显示峰值拉力",
        "Show Grid Lines": "显示网格线",
        "Show Axis Labels": "显示坐标轴标签",
        "X axis maximum (cm):": "横轴上限（厘米）：",
        "Y axis maximum (N):": "纵轴上限（牛顿）：",
        "0 = automatic": "0 = 自动",
        "Enter a value from 0 to 1000": "请输入 0 至 1000 之间的数值",
        "Enter a value from 0 to 5000": "请输入 0 至 5000 之间的数值",
        "Outside selected axis range": "超出所选坐标范围",
        Language: "语言",
        "Language:": "语言：",
        English: "English",
        "Simplified Chinese": "简体中文",
        "中文（简体）": "中文（简体）",
        "Intervals.icu": "Intervals.icu",
        "API Key": "API 密钥",
        "Athlete ID": "运动员 ID",
        "Auto upload to Intervals.icu": "自动上传到 Intervals.icu",
        Logging: "日志",
        "Log Level": "日志级别",
        "Select log level": "选择日志级别",
        "Log level is required": "必须填写日志级别",
        "Invalid value": "值无效",
        "Delta Times:": "时间间隔：",
        Bluetooth: "蓝牙",
        SdCard: "SD 卡",
        Manufacturer: "制造商",
        Model: "型号",
        Hardware: "硬件",
        "FW Version": "固件版本",
        "GUI Version": "界面版本",
        unknown: "未知",
        "Upload firmware": "上传固件",
        "Firmware update available": "有可用固件更新",
        "Firmware update available - View on GitHub": "有可用固件更新 - 在 GitHub 查看",
        "Firmware update available for custom board": "自定义开发板有可用固件更新",
        "View on GitHub": "在 GitHub 查看",
        "Open latest firmware release on GitHub": "打开 GitHub 最新固件版本",
        "Reflash firmware": "重新刷写固件",
        Checking: "正在检查",
        Check: "检查",
        "for update": "更新",
        "Back to dashboard": "返回仪表盘",
        "Back to Dashboard": "返回仪表盘",
        "Open JSON file": "打开 JSON 文件",
        "Loading session...": "正在加载训练记录……",
        Totals: "总计",
        Summary: "摘要",
        Laps: "分段",
        Strokes: "划桨次数",
        Maximums: "最大值",
        Averages: "平均值",
        Pace: "配速",
        Balance: "平衡",
        Consistency: "一致性",
        "Show Full Session": "显示完整训练",
        "Stroke Index": "划桨序号",
        "Elapsed Time": "经过时间",
        Speed: "速度",
        Power: "功率",
        "Stroke Rate": "划频",
        "Heart Rate": "心率",
        "Dist/Stroke": "每桨距离",
        "Drive Length": "驱动距离",
        Drive: "驱动",
        Recovery: "恢复",
        "Drag Factor": "阻力系数",
        "Drag Factor Lower Threshold": "阻力系数下限",
        "Drag Factor Upper Threshold": "阻力系数上限",
        "Previous stroke": "上一桨",
        "Next stroke": "下一桨",
        "Log Book": "训练日志",
        Logbook: "训练日志",
        Date: "日期",
        Device: "设备",
        Actions: "操作",
        "Distance (m)": "距离（米）",
        "Upload to Intervals.icu": "上传到 Intervals.icu",
        "FIT (Strava)": "FIT（Strava）",
        Start: "开始",
        Resume: "继续",
        Pause: "暂停",
        Lap: "分段",
        Stop: "停止",
        "ESP Rowing Monitor": "ESP 划船监视器",
        Searching: "正在搜索",
        "Connect HRM": "连接心率监测器",
        "Connect ESPRM": "连接 ESP 划船监视器",
        "All tiles placed": "所有卡片已放置",
        "Select firmware": "选择固件",
        "Something went wrong": "发生错误",
        "No compatible firmware found for your device.": "没有找到适用于当前设备的固件。",
        "Upgrading database…": "正在升级数据库……",
        "Do not start rowing until this completes.": "完成前请不要开始划船。",
        "Upload sessions to Intervals.icu?": "要上传训练记录到 Intervals.icu 吗？",
        "You have existing sessions. Would you like to upload them all to Intervals.icu?":
            "已有训练记录。是否全部上传到 Intervals.icu？",
        "Your Intervals.icu API key has changed. Would you like to re-upload all sessions with the new key, or only upload sessions not yet uploaded?":
            "Intervals.icu API 密钥已更改。是否使用新密钥重新上传全部训练记录，还是只上传尚未上传的记录？",
        "Duplicate uploads are handled server-side — re-uploading a session will update the existing activity.":
            "重复上传由服务器处理——重新上传训练记录会更新已有活动。",
        "Upload all sessions": "上传全部训练记录",
        "Upload all sessions (recommended)": "上传全部训练记录（推荐）",
        "Only upload new sessions": "只上传新的训练记录",
        Skip: "跳过",
        "Uploading to Intervals.icu": "正在上传到 Intervals.icu",
        Uploaded: "已上传",
        Failed: "失败",
        Close: "关闭",
        "Update in progress": "正在更新",
        "Please do not navigate away from this page and do not restart the device":
            "请不要离开此页面，也不要重启设备",
        Ok: "确定",
        "Export Rower Profile": "导出划船机配置",
        "Device Name": "设备名称",
        "Device name is required": "必须填写设备名称",
        "Device should be maximum 18 characters": "设备名称最多 18 个字符",
        "Invalid character(s) in name": "名称包含无效字符",
        "Model Number": "型号编号",
        "Model number is required": "必须填写型号编号",
        Back: "返回",
        Peak: "峰值",
        Dismiss: "关闭提示",
        "Bluetooth API is not available": "蓝牙 API 不可用",
        "Update Available": "有可用更新",
        Update: "更新",
        "Ergo monitor connected": "划船机监视器已连接",
        "Ergometer Monitor disconnected": "划船机监视器已断开",
        "You have unsaved changes. Close without saving?": "有未保存的修改。要放弃并关闭吗？",
        No: "否",
        Machine: "机器",
        "Physical parameters of the rowing machine": "划船机物理参数",
        "Sensor Signal": "传感器信号",
        "Parameters for drag factor calculation": "阻力系数计算参数",
        "Parameters for stroke detection algorithm": "划桨检测算法参数",
        "Flywheel Inertia": "飞轮惯量",
        "Sprocket Radius": "链轮半径",
        "Magic Constant": "魔法常数",
        "Stroke Detection Type": "划桨检测类型",
        "Minimum Powered Torque": "最小驱动扭矩",
        "Minimum Drag Torque": "最小阻力扭矩",
        "Minimum Recovery Slope Margin (Deprecated)": "最小恢复斜率裕量（已弃用）",
        "Minimum Recovery Slope": "最小恢复斜率",
        "Minimum Recovery Time": "最小恢复时间",
        "Minimum Drive Time": "最小驱动时间",
        "Value yields too many data points (max 1000)": "该值会产生过多数据点（最多 1000）",
        "Start session on new stroke": "新桨开始训练",
        "Start on new stroke, pause when speed reaches zero": "新桨开始，速度为零时暂停",
        "Speed, Power, Stroke Rate": "速度、功率、划频",
        "Minimum value depends on drag factor recovery period": "最小值取决于阻力系数恢复周期",
        "Maximum value depends on the rotation debounce time": "最大值取决于转动去抖时间",
        "Checking for update": "正在检查更新",
        "Check for update": "检查更新",
        "ETA:": "预计剩余时间：",
    };

    private root: HTMLElement | undefined;
    private observer: MutationObserver | undefined;
    private translationScheduled: boolean = false;
    private updatingDom: boolean = false;
    private lastAppliedLanguage: AppLanguage = "en";
    private readonly originalText: WeakMap<Text, string> = new WeakMap<Text, string>();
    private readonly originalAttributes: WeakMap<Element, Map<string, string>> = new WeakMap<
        Element,
        Map<string, string>
    >();

    constructor() {
        effect((): void => {
            const language = this.language();
            if (typeof document !== "undefined") {
                document.documentElement.lang = language;
            }
            this.scheduleTranslation();
        });
    }

    setLanguage(language: AppLanguage): void {
        if (this.language() === language) {
            return;
        }

        try {
            localStorage.setItem(LanguageService.STORAGE_KEY, language);
        } catch {
            // private browsing can deny localStorage; the current session still works.
        }
        this.language.set(language);
    }

    t(value: string): string {
        return this.translateValue(value, this.language());
    }

    start(root: HTMLElement): void {
        this.root = root;
        this.scheduleTranslation();

        if (typeof MutationObserver === "undefined") {
            return;
        }

        this.observer?.disconnect();
        this.observer = new MutationObserver((): void => this.scheduleTranslation());
        this.observer.observe(root, {
            attributes: true,
            attributeFilter: ["aria-label", "placeholder", "title", "mattooltip"],
            characterData: true,
            childList: true,
            subtree: true,
        });
    }

    ngOnDestroy(): void {
        this.observer?.disconnect();
        this.root = undefined;
    }

    private readLanguage(): AppLanguage {
        try {
            const stored = localStorage.getItem(LanguageService.STORAGE_KEY);
            if (stored === "en" || stored === "zh-CN") {
                return stored;
            }
        } catch {
            // use English when browser storage is unavailable.
        }

        return "en";
    }

    private scheduleTranslation(): void {
        if (this.root === undefined || this.translationScheduled) {
            return;
        }

        this.translationScheduled = true;
        queueMicrotask((): void => {
            this.translationScheduled = false;
            if (this.root !== undefined) {
                this.translateTree(this.root);
            }
        });
    }

    private translateTree(root: HTMLElement): void {
        if (this.updatingDom) {
            return;
        }

        this.updatingDom = true;
        try {
            const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let textNode = textWalker.nextNode() as Text | null;
            while (textNode !== null) {
                const parent = textNode.parentElement;
                if (parent !== null && !this.shouldSkip(parent)) {
                    const current = textNode.data;
                    const previous = this.originalText.get(textNode);
                    const original =
                        previous !== undefined &&
                        current === this.translateValue(previous, this.lastAppliedLanguage)
                            ? previous
                            : current;
                    this.originalText.set(textNode, original);
                    const translated = this.translateValue(original, this.language());
                    if (current !== translated) {
                        textNode.data = translated;
                    }
                }
                textNode = textWalker.nextNode() as Text | null;
            }

            const elements: Array<Element> = [root, ...Array.from(root.querySelectorAll("*"))];
            for (const element of elements) {
                for (const attribute of ["aria-label", "placeholder", "title", "mattooltip"]) {
                    if (!element.hasAttribute(attribute)) {
                        continue;
                    }

                    const current = element.getAttribute(attribute) ?? "";
                    const attributes = this.originalAttributes.get(element) ?? new Map<string, string>();
                    const previous = attributes.get(attribute);
                    const original =
                        previous !== undefined &&
                        current === this.translateValue(previous, this.lastAppliedLanguage)
                            ? previous
                            : current;
                    attributes.set(attribute, original);
                    this.originalAttributes.set(element, attributes);
                    const translated = this.translateValue(original, this.language());
                    if (current !== translated) {
                        element.setAttribute(attribute, translated);
                    }
                }
            }
            this.lastAppliedLanguage = this.language();
        } finally {
            this.updatingDom = false;
        }
    }

    private shouldSkip(element: Element): boolean {
        return element.closest("script, style, pre, code") !== null;
    }

    private translateValue(value: string, language: AppLanguage): string {
        if (language === "en") {
            return value;
        }

        const leadingWhitespace = value.match(/^\s*/)?.[0] ?? "";
        const trailingWhitespace = value.match(/\s*$/)?.[0] ?? "";
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            return value;
        }

        let translated = this.translations[trimmed] ?? trimmed;
        const dynamicPatterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
            [
                /^Peak: (.+)N(.*)$/,
                (match: RegExpMatchArray): string => `${this.translations.Peak}: ${match[1]}N${match[2]}`,
            ],
            [
                /^Manufacturer: ?(.*)$/,
                (match: RegExpMatchArray): string => `${this.translations.Manufacturer}: ${match[1]}`,
            ],
            [
                /^Model: ?(.*)$/,
                (match: RegExpMatchArray): string => `${this.translations.Model}: ${match[1]}`,
            ],
            [
                /^Hardware: ?(.*)$/,
                (match: RegExpMatchArray): string => `${this.translations.Hardware}: ${match[1]}`,
            ],
            [
                /^FW Version: ?(.*)$/,
                (match: RegExpMatchArray): string => `${this.translations["FW Version"]}: ${match[1]}`,
            ],
            [
                /^GUI Version: ?(.*)$/,
                (match: RegExpMatchArray): string => `${this.translations["GUI Version"]}: ${match[1]}`,
            ],
            [
                /^Stroke Index: ?(.*)$/,
                (match: RegExpMatchArray): string => `${this.translations["Stroke Index"]}: ${match[1]}`,
            ],
            [
                /^Elapsed Time: ?(.*)$/,
                (match: RegExpMatchArray): string => `${this.translations["Elapsed Time"]}: ${match[1]}`,
            ],
            [/^Pace: ?(.*)$/, (match: RegExpMatchArray): string => `${this.translations.Pace}: ${match[1]}`],
            [
                /^Uploaded: ?(.*)$/,
                (match: RegExpMatchArray): string => `${this.translations.Uploaded}: ${match[1]}`,
            ],
            [
                /^Failed: ?(.*)$/,
                (match: RegExpMatchArray): string => `${this.translations.Failed}: ${match[1]}`,
            ],
            [
                /^Select firmware \(v(.*)\)$/,
                (match: RegExpMatchArray): string =>
                    `${this.translations["Select firmware"]}（v${match[1]}）`,
            ],
            [
                /^Impulses Per Revolution \((.*)\)$/,
                (match: RegExpMatchArray): string => `每转脉冲数（${match[1]}）`,
            ],
            [/^Rotation Debounce \((.*)\)$/, (match: RegExpMatchArray): string => `转动去抖（${match[1]}）`],
            [
                /^Rowing Stop Threshold \((.*)\)$/,
                (match: RegExpMatchArray): string => `划船停止阈值（${match[1]}）`,
            ],
            [
                /^Drag Factor Period \((.*)\)$/,
                (match: RegExpMatchArray): string => `阻力系数周期（${match[1]}）`,
            ],
            [
                /^Drag Coefficients Array Size \((.*)\)$/,
                (match: RegExpMatchArray): string => `阻力系数数组大小（${match[1]}）`,
            ],
            [
                /^Goodness of Fit Threshold \((.*)\)$/,
                (match: RegExpMatchArray): string => `拟合优度阈值（${match[1]}）`,
            ],
            [
                /^Impulse Data Array Size \((.*)\)$/,
                (match: RegExpMatchArray): string => `冲量数据数组大小（${match[1]}）`,
            ],
            [
                /^Drive Handle Forces Size \((.*)\)$/,
                (match: RegExpMatchArray): string => `拉柄力数据大小（${match[1]}）`,
            ],
        ];
        for (const [pattern, format] of dynamicPatterns) {
            const match = trimmed.match(pattern);
            if (match !== null) {
                translated = format(match);
                break;
            }
        }

        return `${leadingWhitespace}${translated}${trailingWhitespace}`;
    }
}
