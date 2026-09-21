import { ChangeDetectionStrategy, Component, computed, input, InputSignal, Signal } from "@angular/core";

import { TrendStyle } from "../../../common/trend.interfaces";

interface TrendPoint {
    readonly x: number;
    readonly y: number;
    readonly intensity: number;
    readonly color: string;
}

const CHART_WIDTH = 120;
const BASELINE = 27;
const TOP = 4;
const START_COLOR = [190, 229, 255] as const;
const END_COLOR = [20, 101, 211] as const;

/**
 * Small, dependency-free trend visualisation shared by every dashboard metric.
 * It intentionally keeps the real sample positions while only smoothing the SVG path.
 * Samples are normalized per metric: the largest value in the visible window is
 * always the darkest blue. Distance passes instantaneous speed samples, so its
 * color describes rowing rate rather than the monotonically increasing total.
 */
@Component({
    selector: "app-metric-trend-chart",
    template: `
        <svg
            class="trend-chart"
            viewBox="0 0 120 32"
            preserveAspectRatio="none"
            role="img"
            [attr.aria-label]="label() + ' recent trend'"
        >
            <defs>
                <linearGradient id="metric-trend-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#2b82e5" stop-opacity="0.28"></stop>
                    <stop offset="100%" stop-color="#d7efff" stop-opacity="0.04"></stop>
                </linearGradient>
            </defs>
            @if (!hasData()) {
                <path class="trend-empty" d="M2 27 H118"></path>
            } @else {
                @switch (chartStyle()) {
                    @case ("bars") {
                        @for (point of points(); track $index) {
                            <rect
                                class="trend-bar"
                                [attr.x]="point.x - barWidth() / 2"
                                [attr.y]="point.y"
                                [attr.width]="barWidth()"
                                [attr.height]="baseline - point.y"
                                [attr.fill]="point.color"
                                rx="1.5"
                            ></rect>
                        }
                    }
                    @case ("line") {
                        <path class="trend-line" [attr.d]="linePath()"></path>
                        @for (point of points(); track $index) {
                            <circle
                                class="trend-dot"
                                [attr.cx]="point.x"
                                [attr.cy]="point.y"
                                r="2.2"
                                [attr.fill]="point.color"
                            ></circle>
                        }
                    }
                    @case ("area") {
                        <path class="trend-area" [attr.d]="areaPath()"></path>
                        <path class="trend-line" [attr.d]="linePath()"></path>
                    }
                }
            }
        </svg>
    `,
    styles: [
        `
            :host {
                display: block;
                width: 100%;
                height: 1.45rem;
                min-height: 1.25rem;
            }

            .trend-chart {
                display: block;
                width: 100%;
                height: 100%;
                overflow: visible;
            }

            .trend-bar {
                transition: y 220ms ease, height 220ms ease, fill 220ms ease;
            }

            .trend-line,
            .trend-area {
                fill: none;
                stroke: #196fd1;
                stroke-width: 1.8;
                stroke-linecap: round;
                stroke-linejoin: round;
                vector-effect: non-scaling-stroke;
                transition: d 220ms ease;
            }

            .trend-area {
                fill: url(#metric-trend-area);
                stroke: none;
            }

            .trend-dot {
                stroke: #ffffff;
                stroke-width: 1;
                vector-effect: non-scaling-stroke;
                transition: cx 220ms ease, cy 220ms ease, fill 220ms ease;
            }

            .trend-empty {
                fill: none;
                stroke: #c9ddec;
                stroke-width: 1.4;
                stroke-dasharray: 2 4;
                vector-effect: non-scaling-stroke;
            }

            @media (prefers-reduced-motion: reduce) {
                .trend-bar,
                .trend-line,
                .trend-dot {
                    transition: none;
                }
            }
        `,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MetricTrendChartComponent {
    readonly baseline: number = BASELINE;
    readonly samples: InputSignal<ReadonlyArray<number>> = input<ReadonlyArray<number>>([]);
    readonly chartStyle: InputSignal<TrendStyle> = input<TrendStyle>("bars");
    readonly label: InputSignal<string> = input<string>("");

    readonly points: Signal<ReadonlyArray<TrendPoint>> = computed((): ReadonlyArray<TrendPoint> => {
        const values = this.samples().filter((value: number): boolean => Number.isFinite(value));

        if (values.length === 0) {
            return [];
        }

        const min = Math.min(...values);
        const max = Math.max(...values);
        const spread = max - min;
        const step = values.length === 1 ? 0 : (CHART_WIDTH - 4) / (values.length - 1);

        return values.map((value: number, index: number): TrendPoint => {
            const intensity = spread === 0 ? 0.5 : (value - min) / spread;
            const y = BASELINE - (TOP + intensity * (BASELINE - TOP));

            return {
                x: values.length === 1 ? CHART_WIDTH / 2 : 2 + index * step,
                y,
                intensity,
                color: this.interpolateColor(intensity),
            };
        });
    });

    readonly hasData: Signal<boolean> = computed((): boolean => this.points().length > 0);
    readonly barWidth: Signal<number> = computed((): number => {
        const count = this.points().length;

        return count === 0 ? 6 : Math.max(3, Math.min(9, (CHART_WIDTH - 4) / count - 1.5));
    });
    readonly linePath: Signal<string> = computed((): string => this.buildSmoothPath(this.points()));
    readonly areaPath: Signal<string> = computed((): string => {
        const points = this.points();

        if (points.length === 0) {
            return "";
        }

        return `${this.buildSmoothPath(points)} L ${points[points.length - 1].x} ${BASELINE} L ${points[0].x} ${BASELINE} Z`;
    });

    private buildSmoothPath(points: ReadonlyArray<TrendPoint>): string {
        if (points.length === 0) {
            return "";
        }

        if (points.length === 1) {
            return `M ${points[0].x} ${points[0].y}`;
        }

        let path = `M ${points[0].x} ${points[0].y}`;

        for (let index = 1; index < points.length; index += 1) {
            const previous = points[index - 1];
            const current = points[index];
            const midpoint = (previous.x + current.x) / 2;

            path += ` C ${midpoint} ${previous.y}, ${midpoint} ${current.y}, ${current.x} ${current.y}`;
        }

        return path;
    }

    private interpolateColor(intensity: number): string {
        const channel = (index: number): number =>
            Math.round(START_COLOR[index] + (END_COLOR[index] - START_COLOR[index]) * intensity);

        return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
    }
}
