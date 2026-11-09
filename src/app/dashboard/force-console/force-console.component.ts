import { DecimalPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import {
    ChartConfiguration,
    ChartOptions,
    LinearScale,
    LineController,
    LineElement,
    PointElement,
    Plugin,
} from "chart.js";
import { BaseChartDirective, provideCharts } from "ng2-charts";
import { ICalculatedMetrics, IDisplayForceCurve } from "../../../common/common.interfaces";
import { ErgConnectionService } from "../../../common/services/ergometer/erg-connection.service";
import { EMPTY_FORCE_HISTORY, curveStatistics, updateForceCurveHistory } from "./force-curve-history";

type MetricKey = "peak" | "position" | "ratio" | "average" | "work" | "duration" | "length";

@Component({
    selector: "app-force-console",
    templateUrl: "./force-console.component.html",
    styleUrl: "./force-console.component.scss",
    imports: [DecimalPipe, BaseChartDirective],
    providers: [provideCharts({ registerables: [LineController, LineElement, PointElement, LinearScale] })],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForceConsoleComponent {
    readonly metrics = input.required<ICalculatedMetrics>();
    readonly elapsedTime = input<number>(0);
    readonly axis = signal<"distance" | "time">("distance");
    readonly history = signal(EMPTY_FORCE_HISTORY);
    readonly demo = signal(false);
    readonly demoIndex = signal(0);
    readonly selectedMetrics = signal<Array<MetricKey>>(["peak", "position", "ratio"]);
    readonly metricChoices: Array<{ key: MetricKey; label: string }> = [
        { key: "peak", label: "峰值拉力" },
        { key: "position", label: "峰值位置" },
        { key: "ratio", label: "平均 / 峰值" },
        { key: "average", label: "平均拉力" },
        { key: "work", label: "单桨做功" },
        { key: "duration", label: "推进时间" },
        { key: "length", label: "拉桨长度" },
    ];
    readonly connection;
    readonly demoMetrics = computed((): ICalculatedMetrics => {
        const index = this.demoIndex();
        const profile = [
            { peak: 800, position: 0.48, length: 1.33, time: 0.92 },
            { peak: 760, position: 0.43, length: 1.3, time: 0.88 },
            { peak: 835, position: 0.51, length: 1.36, time: 0.96 },
            { peak: 790, position: 0.46, length: 1.32, time: 0.9 },
        ][index % 4];
        const samples = Array.from({ length: 101 }, (_, i) => {
            const x = i / 100;
            const amplitude =
                x <= profile.position
                    ? Math.sin((Math.PI * x) / (2 * profile.position))
                    : Math.cos((Math.PI * (x - profile.position)) / (2 * (1 - profile.position)));
            return {
                distance: x * profile.length,
                elapsedTimeUs: Math.round(Math.pow(x, 0.82) * profile.time * 1e6),
                force: Math.max(0, profile.peak * Math.pow(Math.max(0, amplitude), 1.12)),
            };
        });
        return {
            ...this.metrics(),
            sourceEpoch: -1,
            strokeCount: index + 1,
            strokeRate: 24,
            avgStrokePower: 210,
            forceCurveStatus: "complete",
            displayForceCurve: undefined,
            forceCurve: {
                strokeId: index + 1,
                driveLength: profile.length,
                driveDurationUs: profile.time * 1e6,
                samples,
            },
        };
    });
    readonly activeMetrics = computed(() => (this.demo() ? this.demoMetrics() : this.metrics()));
    readonly statistics = computed(() => curveStatistics(this.history().current));
    readonly currentLength = computed(() => this.history().current?.driveLength);
    readonly timeLabel = computed(() => {
        const seconds = this.demo() ? 27 + this.demoIndex() * 3 : Math.max(0, Math.floor(this.elapsedTime()));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    });
    readonly strokeLabel = computed(() => this.history().current?.strokeId ?? "—");
    readonly options = computed((): ChartOptions<"line"> => {
        const curves = [this.history().current, this.history().previous].filter(
            Boolean,
        ) as Array<IDisplayForceCurve>;
        const time = this.axis() === "time";
        const step = time ? 0.2 : 0.25;
        const maxX = Math.max(
            time ? 1.2 : 1.5,
            ...curves.map((c) => (time ? c.driveDurationUs / 1e6 : c.driveLength)),
        );
        const maxY = Math.max(300, ...curves.flatMap((c) => c.samples.map((p) => p.force)));
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                datalabels: { display: false },
                tooltip: { enabled: false },
            },
            interaction: { intersect: false },
            scales: {
                x: {
                    type: "linear",
                    min: 0,
                    max: Math.ceil(maxX / step) * step,
                    grid: { display: false },
                    border: { color: "#6f8da7" },
                    title: {
                        display: true,
                        text: time ? "拉桨时间（s）" : "拉桨距离（cm）",
                        color: "#bed0e0",
                    },
                    ticks: {
                        color: "#bed0e0",
                        maxTicksLimit: 5,
                        callback: (value) =>
                            time ? Number(value).toFixed(1) : String(Math.round(Number(value) * 100)),
                    },
                },
                y: {
                    min: 0,
                    max: Math.ceil((maxY * 1.12) / 100) * 100,
                    grid: { display: false },
                    border: { color: "#6f8da7" },
                    title: { display: true, text: "拉力（N）", color: "#bed0e0" },
                    ticks: { color: "#bed0e0", maxTicksLimit: 4 },
                },
            },
        };
    });
    readonly chartData = computed((): ChartConfiguration<"line">["data"] => {
        const points = (curve?: IDisplayForceCurve) =>
            curve?.samples.map((p) => ({
                x: this.axis() === "time" ? p.elapsedTimeUs / 1e6 : p.distance,
                y: p.force,
            })) ?? [];
        return {
            datasets: [
                {
                    data: points(this.history().previous),
                    label: "上一桨",
                    borderColor: "rgba(239,246,255,.38)",
                    borderDash: [6, 5],
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                },
                {
                    data: points(this.history().current),
                    label: "最近一桨",
                    borderColor: "#f1f7ff",
                    borderWidth: 2.5,
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                },
            ],
        };
    });
    readonly plugins: Array<Plugin<"line">> = [
        {
            id: "force-console-peak",
            afterDatasetsDraw: (chart) => {
                const current = this.history().current;
                if (!current?.samples.length) return;
                const peak = current.samples.reduce((a, b) => (b.force > a.force ? b : a));
                const x = chart.scales.x.getPixelForValue(
                    this.axis() === "time" ? peak.elapsedTimeUs / 1e6 : peak.distance,
                );
                const y = chart.scales.y.getPixelForValue(peak.force);
                const ctx = chart.ctx;
                ctx.save();
                ctx.strokeStyle = "rgba(217,235,100,.4)";
                ctx.setLineDash([2, 5]);
                ctx.beginPath();
                ctx.moveTo(x, y + 8);
                ctx.lineTo(x, chart.chartArea.bottom);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = "#d9eb64";
                ctx.beginPath();
                ctx.arc(x, y, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(x - 5, chart.chartArea.bottom - 8);
                ctx.lineTo(x + 5, chart.chartArea.bottom - 8);
                ctx.lineTo(x, chart.chartArea.bottom - 1);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
            },
        },
    ];

    constructor(connectionService: ErgConnectionService) {
        this.connection = toSignal(connectionService.connectionStatus$(), { requireSync: true });
        effect(() => {
            if (this.connection().status === "connected" && this.demo()) this.demo.set(false);
        });
        effect(() => {
            const data = this.activeMetrics();
            this.history.update((state) => updateForceCurveHistory(state, data));
        });
    }

    nextDemo(): void {
        this.demoIndex.update((value) => value + 1);
    }

    toggleDemo(): void {
        if (this.connection().status === "connected") return;
        this.demoIndex.set(0);
        this.history.set(EMPTY_FORCE_HISTORY);
        this.demo.update((value) => !value);
    }

    selectMetric(index: number, event: Event): void {
        const key = (event.target as HTMLSelectElement).value as MetricKey;
        this.selectedMetrics.update((items) => items.map((item, i) => (i === index ? key : item)));
    }

    metricValue(key: MetricKey): string {
        const stats = this.statistics(),
            curve = this.history().current;
        if (!stats || !curve) return "—";
        switch (key) {
            case "peak":
                return Math.round(stats.peak).toString();
            case "position":
                return (
                    Math.round(this.axis() === "time" ? stats.peakTimePercent : stats.peakDistancePercent) +
                    "%"
                );
            case "ratio":
                return stats.ratio.toFixed(2);
            case "average":
                return Math.round(stats.average).toString();
            case "work":
                return Math.round(stats.work).toString();
            case "duration":
                return (curve.driveDurationUs / 1e6).toFixed(2);
            case "length":
                return Math.round(curve.driveLength * 100).toString();
        }
    }

    metricUnit(key: MetricKey): string {
        return {
            peak: "N",
            position: this.axis() === "time" ? "推进时间" : "推进距离",
            ratio: "",
            average: "N",
            work: "J",
            duration: "s",
            length: "cm",
        }[key];
    }
}
