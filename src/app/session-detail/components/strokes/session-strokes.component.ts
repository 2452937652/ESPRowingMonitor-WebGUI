import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    Injector,
    input,
    InputSignal,
    Signal,
    signal,
    viewChild,
    WritableSignal,
} from "@angular/core";
import { MatIconButton } from "@angular/material/button";
import { MatIcon } from "@angular/material/icon";
import { MatSliderModule } from "@angular/material/slider";
import { MatTooltip } from "@angular/material/tooltip";
import { ChartData, ChartOptions, ChartTypeRegistry, Point, TooltipItem } from "chart.js";
import { Context } from "chartjs-plugin-datalabels";

import { IForceCurvePoint } from "../../../../common/common.interfaces";
import { LanguageService } from "../../../../common/services/language.service";
import { ILap, ISessionStroke } from "../../models/session-analysis.interfaces";
import { SessionChartComponent } from "../shared/session-chart.component";

import { StrokeInspectorComponent } from "./stroke-inspector.component";

const FORCE_CURVE_COLOR = "#11a9ed";
const HIGHLIGHT_COLOR = "#ff6b35";
const PEAK_MARKER_COLOR = "#e53935";
const FORCE_CURVE_DISPLAY_MAX_DISTANCE_METERS = 2;

const hasStrokeDistance = (stroke: ISessionStroke): boolean =>
    (stroke.forceCurve?.length ?? 0) > 0 || stroke.driveLength > 0;

interface IContinuousForceCurveData {
    chartData: ChartData;
    strokeOffsets: Array<number>;
    isPhysical: boolean;
    strokeLengths: Array<number>;
}

const buildLegacyForceCurve: (stroke: ISessionStroke) => Array<IForceCurvePoint> = (
    stroke: ISessionStroke,
): Array<IForceCurvePoint> => {
    const { driveLength, handleForces }: Pick<ISessionStroke, "driveLength" | "handleForces"> = stroke;
    const sampleDistance =
        handleForces.length > 1 && driveLength > 0 ? driveLength / (handleForces.length - 1) : 1;

    return handleForces.map((force: number, index: number): IForceCurvePoint => ({
        distance: sampleDistance * index,
        elapsedTime: 0,
        force,
    }));
};

const getStrokeForceCurve = (stroke: ISessionStroke): Array<IForceCurvePoint> =>
    stroke.forceCurve !== undefined && stroke.forceCurve.length > 0
        ? stroke.forceCurve
        : buildLegacyForceCurve(stroke);

const buildStrokeForcePoints = (stroke: ISessionStroke): Array<Point> => {
    const samples = getStrokeForceCurve(stroke);
    if (samples.length === 0) {
        return [];
    }

    const hasPhysicalCurve = stroke.forceCurve !== undefined && stroke.forceCurve.length > 0;
    const driveLength = Math.max(stroke.driveLength, samples[samples.length - 1].distance);
    const points: Array<Point> = samples.map(({ distance, force }: IForceCurvePoint): Point => ({
        x: distance,
        y: force,
    }));
    const firstPoint = points[0];
    if (hasPhysicalCurve && firstPoint !== undefined && (firstPoint.x !== 0 || firstPoint.y !== 0)) {
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
};

const getStrokeCurveLength = (stroke: ISessionStroke): number => {
    const samples = getStrokeForceCurve(stroke);

    return Math.max(stroke.driveLength, samples[samples.length - 1]?.distance ?? 0);
};

const buildSingleStrokeForceCurve = (
    stroke: ISessionStroke,
    chartMaxY: number,
    peakLabel: string,
): ChartData => {
    const samples = getStrokeForceCurve(stroke);
    const forcePoints = buildStrokeForcePoints(stroke);

    const peakSample = samples.reduce<IForceCurvePoint | undefined>(
        (peak: IForceCurvePoint | undefined, sample: IForceCurvePoint): IForceCurvePoint =>
            peak === undefined || sample.force > peak.force ? sample : peak,
        undefined,
    );
    const peakDistance = peakSample?.distance ?? 0;

    return {
        datasets: [
            {
                data: forcePoints,
                borderColor: FORCE_CURVE_COLOR,
                fill: false,
                label: "Force",
            },
            {
                data: [
                    { x: peakDistance, y: 0 },
                    { x: peakDistance, y: stroke.peakForce },
                    { x: peakDistance, y: chartMaxY },
                ],
                borderColor: PEAK_MARKER_COLOR,
                borderDash: [4, 4],
                borderWidth: 2,
                pointRadius: 0,
                fill: false,
                label: "Peak Position",
                datalabels: {
                    display: (ctx: Context): boolean => ctx.dataIndex === 1,
                    anchor: "end",
                    align: -45,
                    offset: 8,
                    formatter: (): string =>
                        `${peakLabel}: ${Math.round(stroke.peakForce)}N @ ${Math.round(stroke.peakForcePositionNorm)}%`,
                    color: PEAK_MARKER_COLOR,
                    font: { size: 12, weight: "bold" },
                },
            },
        ],
    };
};

const buildContinuousForceCurveData = (strokes: Array<ISessionStroke>): IContinuousForceCurveData => {
    const points: Array<Point> = [];
    const strokeOffsets: Array<number> = [];
    const isPhysical = strokes.every(hasStrokeDistance);
    const strokeLengths: Array<number> = [];
    let xOffset = 0;

    for (const stroke of strokes) {
        strokeOffsets.push(xOffset);
        const strokePoints = isPhysical
            ? buildStrokeForcePoints(stroke)
            : getStrokeForceCurve(stroke).map((sample: IForceCurvePoint, index: number): Point => ({
                  x: index,
                  y: sample.force,
              }));
        strokePoints.forEach((point: Point): void => {
            points.push({ x: xOffset + Number(point.x), y: point.y });
        });
        const length = isPhysical ? getStrokeCurveLength(stroke) : Math.max(1, strokePoints.length - 1);
        strokeLengths.push(length);
        xOffset += length;
    }

    return {
        chartData: {
            datasets: [
                {
                    data: points,
                    borderColor: FORCE_CURVE_COLOR,
                    fill: false,
                    label: "Force",
                    parsing: false,
                },
            ],
        },
        strokeOffsets,
        isPhysical,
        strokeLengths,
    };
};

const computeMaxForce = (strokes: Array<ISessionStroke>): number =>
    strokes.reduce((max: number, stroke: ISessionStroke): number => Math.max(max, stroke.peakForce), 0);

const VIEWPORT_STROKE_COUNT = 15;

@Component({
    selector: "app-session-strokes",
    templateUrl: "./session-strokes.component.html",
    styleUrls: ["./session-strokes.component.scss"],
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        MatIconButton,
        MatIcon,
        MatSliderModule,
        MatTooltip,
        StrokeInspectorComponent,
        SessionChartComponent,
    ],
})
export class SessionStrokesComponent {
    readonly strokes: InputSignal<Array<ISessionStroke>> = input.required<Array<ISessionStroke>>();
    readonly laps: InputSignal<Array<ILap>> = input<Array<ILap>>([]);

    readonly currentStrokeIndex: WritableSignal<number> = signal(0);

    readonly currentStroke: Signal<ISessionStroke> = computed(
        (): ISessionStroke => this.strokes()[this.currentStrokeIndex()],
    );

    readonly maxIndex: Signal<number> = computed((): number => Math.max(0, this.strokes().length - 1));

    readonly singleStrokeForceCurve: Signal<ChartData> = computed((): ChartData => {
        const maxForce = computeMaxForce(this.strokes());

        return buildSingleStrokeForceCurve(
            this.currentStroke(),
            maxForce * 1.05,
            this.languageService.t("Peak"),
        );
    });

    readonly singleStrokeChartOptions: Signal<ChartOptions> = computed((): ChartOptions => {
        const maxForce = computeMaxForce(this.strokes());
        const isPhysical = hasStrokeDistance(this.currentStroke());
        const axisMax = isPhysical
            ? Math.max(
                  FORCE_CURVE_DISPLAY_MAX_DISTANCE_METERS,
                  Math.ceil(Math.max(...this.strokes().filter(hasStrokeDistance).map(getStrokeCurveLength))),
              )
            : Math.max(1, this.currentStroke().handleForces.length - 1);

        return {
            elements: {
                line: { borderWidth: 4 },
            },
            scales: {
                x: {
                    type: "linear",
                    display: true,
                    min: 0,
                    max: axisMax,
                    title: {
                        display: true,
                        text: this.languageService.t(isPhysical ? "Drive Length" : "Sample Index"),
                    },
                    ticks: {
                        display: true,
                        stepSize: 0.25,
                        callback: (value: string | number): string =>
                            isPhysical ? `${Math.round(Number(value) * 100)} cm` : `${value}`,
                    },
                },
                y: {
                    min: 0,
                    max: maxForce * 1.05,
                },
            },
            plugins: {
                tooltip: {
                    filter: (tooltipItem: TooltipItem<keyof ChartTypeRegistry>): boolean =>
                        tooltipItem.dataset.label !== "Peak Position",
                    callbacks: {
                        title: (): string => "",
                    },
                },
                zoom: {
                    pan: { enabled: false },
                    zoom: { wheel: { enabled: false }, drag: { enabled: false } },
                },
            },
        };
    });

    readonly continuousForceCurve: Signal<IContinuousForceCurveData> = computed(
        (): IContinuousForceCurveData => buildContinuousForceCurveData(this.strokes()),
    );

    readonly continuousChartData: Signal<ChartData> = computed((): ChartData => {
        const forceCurveData = this.continuousForceCurve();
        const strokeIndex = this.currentStrokeIndex();
        const stroke = this.strokes()[strokeIndex];

        if (!stroke) {
            return forceCurveData.chartData;
        }

        const offset = forceCurveData.strokeOffsets[strokeIndex];

        const sourcePoints = forceCurveData.isPhysical
            ? buildStrokeForcePoints(stroke)
            : getStrokeForceCurve(stroke).map((sample: IForceCurvePoint, index: number): Point => ({
                  x: index,
                  y: sample.force,
              }));
        const highlightPoints = sourcePoints.map((point: Point): Point => ({
            x: offset + Number(point.x),
            y: point.y,
        }));

        return {
            datasets: [
                ...forceCurveData.chartData.datasets,
                {
                    data: highlightPoints,
                    borderColor: HIGHLIGHT_COLOR,
                    borderWidth: 4,
                    fill: false,
                    label: "Current",
                    parsing: false,
                },
            ],
        };
    });

    readonly continuousChartOptions: Signal<ChartOptions> = computed((): ChartOptions => {
        const maxForce = computeMaxForce(this.strokes());
        const forceCurveData = this.continuousForceCurve();
        const lastStrokeIndex = this.strokes().length - 1;
        const totalDistance =
            lastStrokeIndex >= 0
                ? forceCurveData.strokeOffsets[lastStrokeIndex] +
                  forceCurveData.strokeLengths[lastStrokeIndex]
                : 0;

        return {
            elements: {
                line: { borderWidth: 2 },
            },
            scales: {
                x: {
                    type: "linear",
                    display: true,
                    min: 0,
                    max: Math.max(FORCE_CURVE_DISPLAY_MAX_DISTANCE_METERS, totalDistance),
                    title: {
                        display: true,
                        text: this.languageService.t(
                            forceCurveData.isPhysical ? "Drive Length" : "Sample Index",
                        ),
                    },
                    ticks: {
                        display: true,
                        stepSize: 0.25,
                        callback: (value: string | number): string =>
                            forceCurveData.isPhysical ? `${Math.round(Number(value) * 100)} cm` : `${value}`,
                    },
                },
                y: {
                    min: 0,
                    max: maxForce * 1.1,
                },
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        title: (): string => "",
                    },
                },
                decimation: {
                    enabled: true,
                    algorithm: "lttb",
                    samples: 800,
                    threshold: 3000,
                },
            },
        };
    });

    private readonly continuousChart: Signal<SessionChartComponent | undefined> =
        viewChild<SessionChartComponent>("continuousChart");

    private readonly languageService: LanguageService = inject(LanguageService);

    constructor(private injector: Injector) {}

    onPrevious(): void {
        const index = this.currentStrokeIndex();
        if (index <= 0) {
            return;
        }
        this.currentStrokeIndex.set(index - 1);
        this.syncContinuousChartViewport();
    }

    onNext(): void {
        const index = this.currentStrokeIndex();
        if (index >= this.maxIndex()) {
            return;
        }
        this.currentStrokeIndex.set(index + 1);
        this.syncContinuousChartViewport();
    }

    onSliderChange(value: string): void {
        this.currentStrokeIndex.set(Number(value));
        this.syncContinuousChartViewport();
    }

    onLapSelected(lapNumber: number): void {
        const lap = this.laps().find((candidate: ILap): boolean => candidate.lapNumber === lapNumber);
        if (!lap) {
            return;
        }
        this.currentStrokeIndex.set(lap.startIndex);
        this.syncContinuousChartViewport();
    }

    private syncContinuousChartViewport(): void {
        const forceCurveData = this.continuousForceCurve();

        if (forceCurveData.strokeOffsets.length === 0) {
            return;
        }

        const strokeIndex = this.currentStrokeIndex();
        const halfWindow = Math.floor(VIEWPORT_STROKE_COUNT / 2);
        const startStroke = Math.max(0, strokeIndex - halfWindow);
        const endStroke = Math.min(this.strokes().length - 1, strokeIndex + halfWindow);

        const minX = forceCurveData.strokeOffsets[startStroke];
        const endOffset = forceCurveData.strokeOffsets[endStroke];
        const maxX = endOffset + forceCurveData.strokeLengths[endStroke];

        afterNextRender(
            (): void => {
                this.continuousChart()?.zoomToRange(minX, maxX);
            },
            { injector: this.injector },
        );
    }
}
