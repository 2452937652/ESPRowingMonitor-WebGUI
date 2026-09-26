import { ICalculatedMetrics } from "../../common/common.interfaces";

export interface CompletedMetricsDisplay {
    current?: ICalculatedMetrics;
    completed?: ICalculatedMetrics;
}

/** Presentation only: keep the last completed recovery visible while the next one is in progress. */
export function updateCompletedMetricsDisplay(
    state: CompletedMetricsDisplay,
    incoming: ICalculatedMetrics,
): CompletedMetricsDisplay {
    const shouldReset =
        incoming.strokeCount === 0 ||
        (state.current !== undefined &&
            (incoming.strokeCount < state.current.strokeCount ||
                incoming.sourceEpoch !== state.current.sourceEpoch));
    const completed =
        incoming.isExtendedMetricsPending === true ? (shouldReset ? undefined : state.completed) : incoming;
    const current =
        incoming.isExtendedMetricsPending === true && completed !== undefined
            ? {
                  ...incoming,
                  avgStrokePower: completed.avgStrokePower,
                  recoveryDuration: completed.recoveryDuration,
                  dragFactor: completed.dragFactor,
                  isExtendedMetricsPending: false,
              }
            : incoming;

    return { current, completed };
}
