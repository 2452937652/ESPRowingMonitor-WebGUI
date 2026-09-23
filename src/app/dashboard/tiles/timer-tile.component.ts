import { ChangeDetectionStrategy, Component, input, InputSignal } from "@angular/core";

import { EMPTY_TREND_HISTORY, TrendHistory, TrendStyle } from "../../../common/trend.interfaces";
import { SecondsToTimePipe } from "../../../common/utils/seconds-to-time.pipe";
import { MetricComponent } from "../metric/metric.component";

@Component({
    selector: "app-timer-tile",
    template: `
        <app-metric
            [title]="label()"
            [icon]="icon()"
            [value]="elapseTime() | secondsToTime: 'pace'"
            [trendSamples]="trendHistory().timer"
            [trendStyle]="trendStyle()"
        ></app-metric>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MetricComponent, SecondsToTimePipe],
})
export class TimerTileComponent {
    readonly label: InputSignal<string> = input.required<string>();
    readonly icon: InputSignal<string | undefined> = input<string | undefined>();
    readonly elapseTime: InputSignal<number> = input.required<number>();
    readonly trendHistory: InputSignal<TrendHistory> = input<TrendHistory>(EMPTY_TREND_HISTORY);
    readonly trendStyle: InputSignal<TrendStyle> = input<TrendStyle>("bars");
}
