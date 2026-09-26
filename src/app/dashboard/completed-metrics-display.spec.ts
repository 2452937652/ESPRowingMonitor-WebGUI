import { describe, expect, it } from "vitest";

import { ICalculatedMetrics } from "../../common/common.interfaces";

import { updateCompletedMetricsDisplay } from "./completed-metrics-display";

describe("completed recovery presentation", (): void => {
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
