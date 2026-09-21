import { ChangeDetectionStrategy, Component, input, InputSignal } from "@angular/core";

import { ICalculatedMetrics } from "../../../common/common.interfaces";
import { EMPTY_TREND_HISTORY, TrendHistory, TrendStyle } from "../../../common/trend.interfaces";
import { MetricComponent } from "../metric/metric.component";

@Component({
    selector: "app-total-strokes-tile",
    template: `
        <app-metric
            [title]="label()"
            [icon]="icon()"
            unit="stk"
            [value]="rowingData().strokeCount"
            [trendSamples]="trendHistory().totalStrokes"
            [trendStyle]="trendStyle()"
        ></app-metric>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MetricComponent],
})
export class TotalStrokesTileComponent {
    readonly label: InputSignal<string> = input.required<string>();
    readonly icon: InputSignal<string | undefined> = input<string | undefined>();
    readonly rowingData: InputSignal<ICalculatedMetrics> = input.required<ICalculatedMetrics>();
    readonly trendHistory: InputSignal<TrendHistory> = input<TrendHistory>(EMPTY_TREND_HISTORY);
    readonly trendStyle: InputSignal<TrendStyle> = input<TrendStyle>("bars");
}
