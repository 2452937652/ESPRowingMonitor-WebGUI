/** Visual treatment for the short-term metric history rendered on the dashboard. */
export type TrendStyle = "bars" | "line" | "area";

/** Metric keys whose values can be represented by the shared micro-trend component. */
export type TrendMetricKey =
    | "distance"
    | "pace"
    | "power"
    | "strokeRate"
    | "timer"
    | "distPerStroke"
    | "totalStrokes"
    | "dragFactor"
    | "driveTime"
    | "recoveryTime"
    | "heartRate"
    | "peakForce"
    | "peakForcePositionNorm"
    | "speed"
    | "driveLength"
    | "totalWork";

export type TrendHistory = Readonly<Record<TrendMetricKey, ReadonlyArray<number>>>;

export const EMPTY_TREND_HISTORY: TrendHistory = {
    distance: [],
    pace: [],
    power: [],
    strokeRate: [],
    timer: [],
    distPerStroke: [],
    totalStrokes: [],
    dragFactor: [],
    driveTime: [],
    recoveryTime: [],
    heartRate: [],
    peakForce: [],
    peakForcePositionNorm: [],
    speed: [],
    driveLength: [],
    totalWork: [],
};

