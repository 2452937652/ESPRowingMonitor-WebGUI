import { ChangeDetectionStrategy, Component, input, InputSignal } from "@angular/core";

import { ICalculatedMetrics } from "../../../common/common.interfaces";
import { EMPTY_TREND_HISTORY, TrendHistory, TrendStyle } from "../../../common/trend.interfaces";
import { SecondsToTimePipe } from "../../../common/utils/seconds-to-time.pipe";
import { MetricComponent } from "../metric/metric.component";

@Component({
    selector: "app-pace-tile",
    template: `
        <app-metric
            [title]="label()"
            [icon]="icon()"
            [value]="500 / rowingData().speed | secondsToTime: 'pace'"
            unit="/500m"
            [trendSamples]="trendHistory().pace"
            [trendStyle]="trendStyle()"
        ></app-metric>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MetricComponent, SecondsToTimePipe],
})
export class PaceTileComponent {
    readonly label: InputSignal<string> = input.required<string>();
    readonly icon: InputSignal<string | undefined> = input<string | undefined>();
    readonly rowingData: InputSignal<ICalculatedMetrics> = input.required<ICalculatedMetrics>();
    readonly trendHistory: InputSignal<TrendHistory> = input<TrendHistory>(EMPTY_TREND_HISTORY);
    readonly trendStyle: InputSignal<TrendStyle> = input<TrendStyle>("bars");
}
