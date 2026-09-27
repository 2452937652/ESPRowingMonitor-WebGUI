import { ChangeDetectionStrategy, Component, computed, input, InputSignal, Signal } from "@angular/core";

import { ICalculatedMetrics } from "../../../common/common.interfaces";
import { isKayakErgometer } from "../../../common/utils/utility.functions";
import { MetricComponent } from "../metric/metric.component";

@Component({
    selector: "app-power-balance-tile",
    template: `
        <app-metric
            [trendEnabled]="false"
            [title]="label()"
            [icon]="icon()"
            [value]="displayValue()"
        ></app-metric>
    `,
    styles: [":host { --metric-value-font-size: min(13cqi, 28cqb); }"],
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MetricComponent],
})
export class PowerBalanceTileComponent {
    readonly label: InputSignal<string> = input.required<string>();
    readonly icon: InputSignal<string | undefined> = input<string | undefined>();
    readonly rowingData: InputSignal<ICalculatedMetrics> = input.required<ICalculatedMetrics>();
    readonly deviceName: InputSignal<string | undefined> = input<string | undefined>();

    readonly displayValue: Signal<string> = computed((): string => {
        if (!isKayakErgometer(this.deviceName())) {
            return "N/A";
        }

        const sideAPercent = Math.round(this.rowingData().powerBalance * 100);

        return `A ${sideAPercent}% / B ${100 - sideAPercent}%`;
    });
}
