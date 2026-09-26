import { describe, expect, it } from "vitest";

import { ICalculatedMetrics } from "../../common/common.interfaces";

import { updateCompletedMetricsDisplay } from "./completed-metrics-display";

describe("completed recovery presentation", (): void => {
    it("holds measured stroke tiles while the next curve is pending without altering the recording", (): void => {
        const complete = {
            strokeCount: 4,
            sourceEpoch: 10,
            strokeRate: 20,
            distPerStroke: 9,
            driveLength: 1.4,
            driveDuration: 1,
            peakForce: 220,
            peakForcePositionNorm: 45,
            forceCurveStatus: "complete",
            isExtendedMetricsPending: false,
        } as ICalculatedMetrics;
        const pending = {
            ...complete,
            strokeCount: 5,
            strokeRate: 0,
            distPerStroke: 0,
            driveLength: 0,
            driveDuration: 0,
            peakForce: 0,
            forceCurveStatus: "pending" as const,
            isExtendedMetricsPending: true,
        };
        const state = updateCompletedMetricsDisplay(updateCompletedMetricsDisplay({}, complete), pending);
        expect(state.current).toMatchObject({
            strokeCount: 5,
            strokeRate: 20,
            distPerStroke: 9,
            driveLength: 1.4,
            peakForce: 220,
        });
        expect(pending.driveLength).toBe(0);
        expect(
            updateCompletedMetricsDisplay(state, { ...pending, sourceEpoch: 11 }).current?.driveLength,
        ).toBe(0);
    });
    it("keeps the previous completion visible without mutating a pending recorded stroke", (): void => {
        const complete = {
            strokeCount: 4,
            sourceEpoch: 0,
            avgStrokePower: 80,
            recoveryDuration: 2,
            dragFactor: 90,
            isExtendedMetricsPending: false,
        } as ICalculatedMetrics;
        const pending = {
            ...complete,
            strokeCount: 5,
            recoveryDuration: 0,
            avgStrokePower: 0,
            isExtendedMetricsPending: true,
        };
        const state = updateCompletedMetricsDisplay(updateCompletedMetricsDisplay({}, complete), pending);
        expect(state.current?.recoveryDuration).toBe(2);
        expect(state.current?.avgStrokePower).toBe(80);
        expect(pending.isExtendedMetricsPending).toBe(true);
        expect(pending.recoveryDuration).toBe(0);
        expect(
            updateCompletedMetricsDisplay(state, { ...pending, sourceEpoch: 1 }).current
                ?.isExtendedMetricsPending,
        ).toBe(true);
        expect(
            updateCompletedMetricsDisplay(state, { ...pending, strokeCount: 0 }).completed,
        ).toBeUndefined();
    });
});
