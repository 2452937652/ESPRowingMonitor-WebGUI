import { describe, expect, it } from "vitest";
import { ICalculatedMetrics, IForceCurve } from "../../../common/common.interfaces";
import { createMockMetrics } from "../tiles/dashboard-tile.test.helpers";
import { EMPTY_FORCE_HISTORY, curveStatistics, updateForceCurveHistory } from "./force-curve-history";

const metrics = (id: number, epoch = 1, curveOverride: Partial<IForceCurve> = {}): ICalculatedMetrics =>
    createMockMetrics({
        sourceEpoch: epoch,
        strokeCount: id,
        forceCurveStatus: "complete",
        forceCurve: {
            strokeId: id,
            driveLength: 1,
            driveDurationUs: 1_000_000,
            samples: [
                { distance: 0, elapsedTimeUs: 0, force: 0 },
                { distance: 0.2, elapsedTimeUs: 400_000, force: 100 },
                { distance: 1, elapsedTimeUs: 1_000_000, force: 0 },
            ],
            ...curveOverride,
        },
    });

describe("force curve comparison state", () => {
    it("rolls complete strokes once and never compares a stroke against its duplicate", () => {
        let state = updateForceCurveHistory(EMPTY_FORCE_HISTORY, metrics(1));
        state = updateForceCurveHistory(state, metrics(1));
        expect(state.previous).toBeUndefined();
        state = updateForceCurveHistory(state, metrics(2));
        state = updateForceCurveHistory(state, metrics(2));
        expect(state.current?.strokeId).toBe(2);
        expect(state.previous?.strokeId).toBe(1);
    });
    it("preserves the complete pair during pending fragments and ignores out-of-order curves", () => {
        let state = updateForceCurveHistory(EMPTY_FORCE_HISTORY, metrics(1));
        state = updateForceCurveHistory(state, metrics(2));
        state = updateForceCurveHistory(state, { ...metrics(3), forceCurveStatus: "pending" });
        expect(state.current?.strokeId).toBe(2);
        state = updateForceCurveHistory(state, { ...metrics(1), strokeCount: 3 });
        expect(state.current?.strokeId).toBe(2);
        expect(state.previous?.strokeId).toBe(1);
    });
    it("clears history across reconnections and new sessions", () => {
        let state = updateForceCurveHistory(EMPTY_FORCE_HISTORY, metrics(8));
        state = updateForceCurveHistory(state, metrics(9, 2));
        expect(state.previous).toBeUndefined();
        state = updateForceCurveHistory(state, createMockMetrics({ sourceEpoch: 2 }));
        expect(state.current).toBeUndefined();
    });
    it("copies samples and rejects invalid or anomalous data", () => {
        const input = metrics(1);
        let state = updateForceCurveHistory(EMPTY_FORCE_HISTORY, input);
        input.forceCurve!.samples[1].force = 999;
        expect(state.current?.samples[1].force).toBe(100);
        state = updateForceCurveHistory(state, { ...metrics(2), isDriveLengthAnomalous: true });
        expect(state.current?.strokeId).toBe(1);
        state = updateForceCurveHistory(
            state,
            metrics(3, 1, {
                samples: [
                    { distance: 0.5, elapsedTimeUs: 100, force: 1 },
                    { distance: 0.2, elapsedTimeUs: 200, force: 2 },
                ],
            }),
        );
        expect(state.current?.strokeId).toBe(1);
    });
    it("computes coordinate-based peak positions and distance-weighted force", () => {
        const state = updateForceCurveHistory(EMPTY_FORCE_HISTORY, metrics(1));
        expect(curveStatistics(state.current)).toEqual({
            peak: 100,
            peakDistancePercent: 20,
            peakTimePercent: 40,
            average: 50,
            work: 50,
            ratio: 0.5,
        });
    });
});
