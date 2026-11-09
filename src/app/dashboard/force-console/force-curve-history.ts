import { ICalculatedMetrics, IDisplayForceCurve, IForceCurvePoint } from "../../../common/common.interfaces";

export interface ForceCurveHistory {
    sourceEpoch?: number;
    strokeCount: number;
    current?: IDisplayForceCurve;
    previous?: IDisplayForceCurve;
}

export const EMPTY_FORCE_HISTORY: ForceCurveHistory = { strokeCount: 0 };

export function updateForceCurveHistory(
    state: ForceCurveHistory,
    data: ICalculatedMetrics,
): ForceCurveHistory {
    const reset =
        data.sourceEpoch !== state.sourceEpoch ||
        data.strokeCount < state.strokeCount ||
        (data.strokeCount === 0 && state.strokeCount > 0);
    const base: ForceCurveHistory = reset
        ? { sourceEpoch: data.sourceEpoch, strokeCount: data.strokeCount }
        : { ...state, strokeCount: data.strokeCount };
    const curve =
        data.displayForceCurve ??
        (data.forceCurveStatus === "complete" && data.forceCurve
            ? { ...data.forceCurve, isDriveLengthAnomalous: data.isDriveLengthAnomalous === true }
            : undefined);
    if (
        !curve ||
        curve.isDriveLengthAnomalous ||
        curve.samples.length < 2 ||
        !Number.isFinite(curve.driveLength) ||
        curve.driveLength <= 0 ||
        !Number.isFinite(curve.driveDurationUs) ||
        curve.driveDurationUs <= 0 ||
        curve.samples.some(
            (point: IForceCurvePoint, index: number): boolean =>
                !Number.isFinite(point.force) ||
                point.force < 0 ||
                !Number.isFinite(point.distance) ||
                point.distance < 0 ||
                !Number.isFinite(point.elapsedTimeUs) ||
                point.elapsedTimeUs < 0 ||
                (index > 0 &&
                    (point.distance < curve.samples[index - 1].distance ||
                        point.elapsedTimeUs < curve.samples[index - 1].elapsedTimeUs)),
        )
    ) {
        return base;
    }
    if (base.current && curve.strokeId < base.current.strokeId) return base;
    const snapshot = { ...curve, samples: curve.samples.map((point) => ({ ...point })) };
    return {
        ...base,
        current: snapshot,
        previous: base.current?.strokeId === curve.strokeId ? base.previous : base.current,
    };
}

export function curveStatistics(curve?: IDisplayForceCurve):
    | {
          peak: number;
          peakDistancePercent: number;
          peakTimePercent: number;
          average: number;
          ratio: number;
          work: number;
      }
    | undefined {
    if (!curve || curve.samples.length < 2) return undefined;
    const peak = curve.samples.reduce((maximum, point) => (point.force > maximum.force ? point : maximum));
    let work = 0;
    for (let i = 1; i < curve.samples.length; i++) {
        const a = curve.samples[i - 1],
            b = curve.samples[i];
        work += ((b.distance - a.distance) * (a.force + b.force)) / 2;
    }
    const average = work / curve.driveLength;
    return {
        peak: peak.force,
        peakDistancePercent: (peak.distance / curve.driveLength) * 100,
        peakTimePercent: (peak.elapsedTimeUs / curve.driveDurationUs) * 100,
        average,
        ratio: peak.force > 0 ? average / peak.force : 0,
        work,
    };
}
