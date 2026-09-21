import { DecimalPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, input, InputSignal, Signal } from "@angular/core";

import { ICalculatedMetrics, IDisplayConfig } from "../../../common/common.interfaces";
import { EMPTY_TREND_HISTORY, TrendHistory, TrendStyle } from "../../../common/trend.interfaces";
import { MetersToMilesPipe } from "../../../common/utils/meters-to-miles.pipe";
import { MetricComponent } from "../metric/metric.component";

@Component({
    selector: "app-distance-tile",
    template: `
        <app-metric
            [title]="label()"
            [icon]="icon()"
            [value]="(distance() | number: (isImperial() ? '0.0-2' : '0.0-0')) ?? '--'"
            [unit]="isImperial() ? 'mi' : 'm'"
            [trendSamples]="trendHistory().distance"
            [trendStyle]="trendStyle()"
        ></app-metric>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MetricComponent, DecimalPipe],
})
export class DistanceTileComponent {
    readonly label: InputSignal<string> = input.required<string>();
    readonly icon: InputSignal<string | undefined> = input<string | undefined>();
    readonly rowingData: InputSignal<ICalculatedMetrics> = input.required<ICalculatedMetrics>();
    readonly displayConfig: InputSignal<IDisplayConfig> = input.required<IDisplayConfig>();
    readonly trendHistory: InputSignal<TrendHistory> = input<TrendHistory>(EMPTY_TREND_HISTORY);
    readonly trendStyle: InputSignal<TrendStyle> = input<TrendStyle>("bars");

    readonly isImperial: Signal<boolean> = computed(
        (): boolean => this.displayConfig().general.unitSystem === "imperial",
    );

    readonly distance: Signal<number> = computed((): number => {
        const dist = this.rowingData().distance / 100;

        if (this.isImperial()) {
            return new MetersToMilesPipe().transform(dist);
        }

        return dist;
    });
}
