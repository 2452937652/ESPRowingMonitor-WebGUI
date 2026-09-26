import { ICalculatedMetrics } from "../../common/common.interfaces";

export interface CompletedMetricsDisplay {
    current?: ICalculatedMetrics;
    completed?: ICalculatedMetrics;
    drive?: ICalculatedMetrics;
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
    const drive = incoming.forceCurveStatus === "complete" ? incoming : shouldReset ? undefined : state.drive;
    let current =
        incoming.isExtendedMetricsPending === true && completed !== undefined
            ? {
                  ...incoming,
                  avgStrokePower: completed.avgStrokePower,
                  recoveryDuration: completed.recoveryDuration,
                  dragFactor: completed.dragFactor,
                  isExtendedMetricsPending: false,
              }
            : incoming;

    if (!shouldReset && state.current !== undefined && incoming.sourceEpoch !== undefined) {
        current = {
            ...current,
            strokeRate: incoming.strokeRate > 0 ? incoming.strokeRate : state.current.strokeRate,
            distPerStroke: incoming.distPerStroke > 0 ? incoming.distPerStroke : state.current.distPerStroke,
        };
    }
    if (incoming.forceCurveStatus === "pending" && drive !== undefined) {
        current = {
            ...current,
            driveLength: drive.driveLength,
            driveDuration: drive.driveDuration,
            peakForce: drive.peakForce,
            peakForcePositionNorm: drive.peakForcePositionNorm,
        };
    }

    return { current, completed, drive };
}
