import { DecimalPipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, input, InputSignal } from "@angular/core";

import { ICalculatedMetrics } from "../../../common/common.interfaces";
import { EMPTY_TREND_HISTORY, TrendHistory, TrendStyle } from "../../../common/trend.interfaces";
import { MetricComponent } from "../metric/metric.component";

@Component({
    selector: "app-power-tile",
    template: `
        <app-metric
            [title]="label()"
            [icon]="icon()"
            [value]="
                rowingData().isExtendedMetricsPending === true
                    ? '--'
                    : ((rowingData().avgStrokePower | number: '0.0-0') ?? '--')
            "
            unit="watt"
            [trendSamples]="trendHistory().power"
            [trendStyle]="trendStyle()"
        ></app-metric>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MetricComponent, DecimalPipe],
})
export class PowerTileComponent {
    readonly label: InputSignal<string> = input.required<string>();
    readonly icon: InputSignal<string | undefined> = input<string | undefined>();
    readonly rowingData: InputSignal<ICalculatedMetrics> = input.required<ICalculatedMetrics>();
    readonly trendHistory: InputSignal<TrendHistory> = input<TrendHistory>(EMPTY_TREND_HISTORY);
    readonly trendStyle: InputSignal<TrendStyle> = input<TrendStyle>("bars");
}
