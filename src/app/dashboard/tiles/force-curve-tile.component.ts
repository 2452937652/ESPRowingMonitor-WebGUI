import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    InputSignal,
    Signal,
    viewChild,
} from "@angular/core";
import { MatCard } from "@angular/material/card";
import {
    CategoryScale,
    ChartConfiguration,
    ChartOptions,
    Filler,
    Legend,
    LinearScale,
    LineController,
    LineElement,
    Point,
    PointElement,
    Title,
} from "chart.js";
import ChartDataLabels, { Context } from "chartjs-plugin-datalabels";
import { BaseChartDirective, provideCharts } from "ng2-charts";

import { ICalculatedMetrics, IDisplayConfig, IForceCurvePoint } from "../../../common/common.interfaces";
import { LanguageService } from "../../../common/services/language.service";
import { isKayakErgometer } from "../../../common/utils/utility.functions";

@Component({
    selector: "app-force-curve-tile",
    template: `
        <mat-card>
            <canvas
                baseChart
                height="100"
                [data]="handleForcesChart()"
                [options]="forceChartOptions()"
                type="line"
            ></canvas>
        </mat-card>
    `,
    styles: [
        `
            :host {
                display: block;
                height: 100%;
            }

            mat-card {
                height: 100%;
                min-height: 100%;
                box-sizing: border-box;
                padding: 0.8rem;
                border: 1px solid rgba(38, 113, 184, 0.12);
                border-radius: 20px;
                background: rgba(255, 255, 255, 0.94);
                box-shadow: 0 10px 28px rgba(27, 78, 125, 0.1);
            }

            canvas {
                padding: 0.2rem;
            }
        `,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MatCard, BaseChartDirective],
    providers: [
        provideCharts({
            registerables: [
                LineController,
                LineElement,
                PointElement,
                LinearScale,
                CategoryScale,
                Filler,
                Title,
                Legend,
                ChartDataLabels,
            ],
        }),
    ],
})
export class ForceCurveTileComponent {
    private static readonly FORCE_CURVE_DISPLAY_MAX_DISTANCE_METERS: number = 2;

    readonly label: InputSignal<string> = input.required<string>();
    readonly icon: InputSignal<string | undefined> = input<string | undefined>();
    readonly rowingData: InputSignal<ICalculatedMetrics> = input.required<ICalculatedMetrics>();
    readonly displayConfig: InputSignal<IDisplayConfig> = input.required<IDisplayConfig>();
    readonly deviceName: InputSignal<string | undefined> = input<string | undefined>();

    readonly strokeSide: Signal<"A" | "B" | undefined> = computed((): "A" | "B" | undefined =>
        isKayakErgometer(this.deviceName())
            ? this.rowingData().strokeCount % 2 === 1
                ? "A"
                : "B"
            : undefined,
    );

    readonly handleForces: Signal<Array<number>> = computed(
        (): Array<number> => this.rowingData().handleForces,
    );
    readonly forceCurve: Signal<Array<IForceCurvePoint>> = computed((): Array<IForceCurvePoint> => {
        const data = this.rowingData();
        if (data.forceCurve !== undefined && data.forceCurve.length > 0) {
            return data.forceCurve;
        }

        const driveLength = data.driveLength;
        const forces = data.handleForces;
        // legacy records do not always carry driveLength. Preserve their sample-index
        // spacing instead of collapsing every point onto x=0.
        const sampleDistance = forces.length > 1 && driveLength > 0 ? driveLength / (forces.length - 1) : 1;

        return forces.map((force: number, index: number): IForceCurvePoint => ({
            distance: sampleDistance * index,
            elapsedTime: 0,
            force,
        }));
    });
    readonly hasDistance: Signal<boolean> = computed(
        (): boolean => (this.rowingData().forceCurve?.length ?? 0) > 0 || this.rowingData().driveLength > 0,
    );
    readonly curvePoints: Signal<Array<Point>> = computed((): Array<Point> => {
        const samples = this.forceCurve();
        if (samples.length === 0) {
            return [];
        }

        const data = this.rowingData();
        const hasPhysicalCurve = data.forceCurve !== undefined && data.forceCurve.length > 0;
        const driveLength = Math.max(data.driveLength, samples[samples.length - 1].distance);
        const points: Array<Point> = samples.map(({ distance, force }: IForceCurvePoint): Point => ({
            x: distance,
            y: force,
        }));

        if (hasPhysicalCurve && (points[0].x !== 0 || points[0].y !== 0)) {
            points.unshift({ x: 0, y: 0 });
        }
        const lastPoint = points[points.length - 1];
        if (
            lastPoint !== undefined &&
            lastPoint.x !== null &&
            (driveLength > lastPoint.x || (hasPhysicalCurve && lastPoint.y !== 0))
        ) {
            points.push({ x: driveLength, y: 0 });
        }

        return points;
    });
    readonly showPeakInTitle: Signal<boolean> = computed(
        (): boolean => this.displayConfig().forceCurve.showPeakForceInTitle,
    );
    readonly showGridLines: Signal<boolean> = computed(
        (): boolean => this.displayConfig().forceCurve.showGridLines,
    );
    readonly showAxisLabels: Signal<boolean> = computed(
        (): boolean => this.displayConfig().forceCurve.showAxisLabels,
    );

    readonly forceChartOptions: Signal<ChartOptions<"line">> = computed((): ChartOptions<"line"> => {
        const shouldShowPeakInTitle = this.showPeakInTitle();
        const handleForcesData = this.forceCurve().map(({ force }: IForceCurvePoint): number => force);
        const shouldShowGridLines = this.showGridLines();
        const shouldShowAxisLabels = this.showAxisLabels();
        const tileLabel = this.languageService.t(this.label());
        const side = this.strokeSide();
        const sideLabel = side !== undefined ? ` (${side})` : "";

        if (
            this._forceChartOptions.plugins?.legend?.title === undefined ||
            this._forceChartOptions.plugins?.datalabels === undefined ||
            this._forceChartOptions.scales?.y === undefined ||
            this._forceChartOptions.scales?.x === undefined
        ) {
            return { ...this._forceChartOptions };
        }

        this._forceChartOptions.scales.y.grid = {
            display: shouldShowGridLines,
        };
        this._forceChartOptions.scales.y.border = {
            display: shouldShowAxisLabels || shouldShowGridLines,
        };
        this._forceChartOptions.scales.y.ticks = {
            display: shouldShowAxisLabels,
            color: "#49647f",
        };
        this._forceChartOptions.scales.x.grid = { display: shouldShowGridLines };
        this._forceChartOptions.scales.x.border = {
            display: shouldShowAxisLabels || shouldShowGridLines,
        };
        const isPhysical = this.hasDistance();
        const lastDistance = this.forceCurve().at(-1)?.distance ?? 0;
        if (isPhysical) {
            this.distanceAxisMax = Math.max(
                this.distanceAxisMax,
                Math.ceil(Math.max(this.rowingData().driveLength, lastDistance)),
            );
        }
        this._forceChartOptions.scales.x.max = isPhysical ? this.distanceAxisMax : Math.max(1, lastDistance);
        this._forceChartOptions.scales.x.title = {
            display: shouldShowAxisLabels,
            text: this.languageService.t(isPhysical ? "Drive Length" : "Sample Index"),
        };
        this._forceChartOptions.scales.x.ticks = {
            display: shouldShowAxisLabels,
            color: "#49647f",
            callback: (value: string | number): string =>
                isPhysical ? `${Math.round(Number(value) * 100)} cm` : `${value}`,
        };

        if (handleForcesData.length === 0) {
            this._forceChartOptions.plugins.legend.title.display = true;
            this._forceChartOptions.plugins.legend.title.text = `${tileLabel}${sideLabel}`;
            this._forceChartOptions.plugins.datalabels.display = false;

            return { ...this._forceChartOptions };
        }

        this._forceChartOptions.plugins.legend.title.display = shouldShowPeakInTitle;
        this._forceChartOptions.plugins.legend.title.text = `${this.languageService.t("Peak")}: ${Math.round(Math.max(...handleForcesData))}N${sideLabel}`;
        this._forceChartOptions.plugins.datalabels.display = shouldShowPeakInTitle
            ? false
            : (ctx: Context): boolean =>
                  Math.max(
                      ...(ctx.dataset.data as Array<Point>).map((point: Point): number => point.y ?? 0),
                  ) === (ctx.dataset.data[ctx.dataIndex] as Point).y;

        return { ...this._forceChartOptions };
    });

    readonly handleForcesChart: Signal<ChartConfiguration<"line">["data"]> = computed(
        (): ChartConfiguration<"line">["data"] => {
            this._handleForcesChart.datasets[0].data = this.curvePoints();

            return { ...this._handleForcesChart };
        },
    );

    // hold the distance scale after long drives for consistent comparisons.
    private distanceAxisMax: number = ForceCurveTileComponent.FORCE_CURVE_DISPLAY_MAX_DISTANCE_METERS;

    private readonly languageService: LanguageService = inject(LanguageService);

    private _forceChartOptions: ChartOptions<"line"> = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            datalabels: {
                anchor: "center",
                align: "top",
                offset: -2,
                formatter: (value: Point): string =>
                    `${this.languageService.t("Peak")}: ${Math.round(value.y ?? 0)}`,
                display: (ctx: Context): boolean =>
                    Math.max(
                        ...(ctx.dataset.data as Array<Point>).map((point: Point): number => point.y ?? 0),
                    ) === (ctx.dataset.data[ctx.dataIndex] as Point).y,
                font: {
                    size: 16,
                },
                color: "#49647f",
            },
            legend: {
                title: {
                    display: true,
                    text: "Force Curve",
                    color: "rgb(0,0,0)",
                    font: {
                        size: 18,
                    },
                    padding: {},
                },
                labels: {
                    boxWidth: 0,
                    font: {
                        size: 0,
                    },
                },
            },
        },
        scales: {
            x: {
                type: "linear",
                display: true,
                min: 0,
                max: ForceCurveTileComponent.FORCE_CURVE_DISPLAY_MAX_DISTANCE_METERS,
                ticks: { stepSize: 0.25 },
            },
            y: {
                ticks: { color: "#49647f" },
                grid: { color: "rgba(42, 117, 188, 0.12)" },
                beginAtZero: true,
            },
        },
        animations: {
            tension: {
                duration: 200,
                easing: "linear",
            },
            y: {
                duration: 200,
                easing: "linear",
            },
            x: {
                duration: 200,
                easing: "linear",
            },
        },
    };

    private _handleForcesChart: ChartConfiguration<"line">["data"] = {
        datasets: [
            {
                fill: true,
                label: "",
                data: [],
                borderColor: "#1674d1",
                backgroundColor: "rgba(87, 174, 235, 0.28)",
                pointRadius: 0,
            },
        ],
    };

    private readonly chartDirective: Signal<BaseChartDirective | undefined> = viewChild(BaseChartDirective);

    constructor() {
        effect((): void => {
            this.displayConfig();
            this.chartDirective()?.chart?.resize();
        });
    }
}
