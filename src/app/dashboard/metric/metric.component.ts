import { ChangeDetectionStrategy, Component, computed, input, InputSignal, Signal } from "@angular/core";
import { MatCard } from "@angular/material/card";
import { MatIcon } from "@angular/material/icon";
import { MatTooltip } from "@angular/material/tooltip";

import { TrendStyle } from "../../../common/trend.interfaces";

import { MetricTrendChartComponent } from "./metric-trend-chart.component";

@Component({
    selector: "app-metric",
    templateUrl: "./metric.component.html",
    styleUrls: ["./metric.component.scss"],
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MatCard, MatIcon, MatTooltip, MetricTrendChartComponent],
})
export class MetricComponent {
    readonly trendEnabled: InputSignal<boolean> = input(true);
    readonly showTrend: Signal<boolean> = computed(
        (): boolean => this.trendEnabled() && this.trendStyle() !== "off",
    );
    readonly icon: InputSignal<string | undefined> = input();
    readonly title: InputSignal<string | undefined> = input();
    readonly unit: InputSignal<string | undefined> = input();
    readonly value: InputSignal<string | number> = input.required<string | number>();
    readonly trendSamples: InputSignal<ReadonlyArray<number>> = input<ReadonlyArray<number>>([]);
    readonly trendIntensitySamples: InputSignal<ReadonlyArray<number>> = input<ReadonlyArray<number>>([]);
    readonly trendStyle: InputSignal<TrendStyle> = input<TrendStyle>("bars");
}
