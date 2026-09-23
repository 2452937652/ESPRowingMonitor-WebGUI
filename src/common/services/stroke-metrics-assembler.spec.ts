import { describe, expect, it, vi } from "vitest";

import { IBaseMetrics } from "../common.interfaces";

import { ICompletedStrokeMetricsV2 } from "./ergometer/completed-stroke-v2-decoder";
import { IPhysicalForceCurveV2 } from "./ergometer/physical-force-curve-v2-decoder";
import { StrokeMetricsAssembler } from "./stroke-metrics-assembler";

function base(strokeCount: number, distance: number = strokeCount * 100): IBaseMetrics {
    return {
        revTime: strokeCount * 1_000_000,
        distance,
        strokeTime: strokeCount * 2_000_000,
        strokeCount,
    };
}

function curve(strokeId: number, force: number = 80): IPhysicalForceCurveV2 {
    return {
        strokeId,
        driveLength: 0.5,
        driveDurationUs: 1_000_000,
        samples: [{ distance: 0.4, elapsedTimeUs: 800_000, force }],
    };
}

function completed(strokeId: number, recoveryComplete: boolean = true): ICompletedStrokeMetricsV2 {
    return recoveryComplete
        ? {
              strokeId,
              driveDurationUs: 1_000_000,
              recovery: {
                  status: "complete",
                  durationUs: 1_200_000,
                  avgStrokePowerW: 240,
                  dragFactor: 122,
              },
          }
        : {
              strokeId,
              driveDurationUs: 1_000_000,
              recovery: { status: "pending" },
          };
}

describe("StrokeMetricsAssembler", (): void => {
    it("joins Base, completed metrics, and curve when they arrive in Base-first order", (): void => {
        const assembler = new StrokeMetricsAssembler();
        const baseUpdate = assembler.acceptBaseMetrics(base(10));
        const pendingUpdate = assembler.acceptCompletedMetrics(completed(10, false));
        const curveUpdate = assembler.acceptPhysicalCurve(curve(10));

        expect(baseUpdate.assembly).toMatchObject({
            sourceEpoch: 0,
            sourceStrokeId: 10,
            base: { strokeCount: 10 },
        });
        expect(pendingUpdate.assembly?.completedMetrics?.recovery).toEqual({ status: "pending" });
        expect(curveUpdate.assembly).toMatchObject({
            sourceStrokeId: 10,
            physicalCurve: { strokeId: 10 },
            completedMetrics: { recovery: { status: "pending" } },
        });
    });

    it("holds curve and completed metrics before Base without creating a stroke", (): void => {
        const assembler = new StrokeMetricsAssembler();

        expect(assembler.acceptPhysicalCurve(curve(11)).assembly).toBeUndefined();
        expect(assembler.acceptCompletedMetrics(completed(11)).assembly).toBeUndefined();

        const baseUpdate = assembler.acceptBaseMetrics(base(11));
        expect(baseUpdate.assembly).toMatchObject({
            sourceStrokeId: 11,
            physicalCurve: { strokeId: 11 },
            completedMetrics: { recovery: { status: "complete", avgStrokePowerW: 240 } },
        });
    });

    it("allows Extended and curve to arrive before Base in either order", (): void => {
        const curveFirst = new StrokeMetricsAssembler();
        curveFirst.acceptPhysicalCurve(curve(12));
        curveFirst.acceptCompletedMetrics(completed(12));
        const afterBase = curveFirst.acceptBaseMetrics(base(12));

        const extendedFirst = new StrokeMetricsAssembler();
        extendedFirst.acceptCompletedMetrics(completed(13));
        extendedFirst.acceptPhysicalCurve(curve(13));
        const otherBase = extendedFirst.acceptBaseMetrics(base(13));

        expect(afterBase.assembly?.sourceStrokeId).toBe(12);
        expect(otherBase.assembly?.sourceStrokeId).toBe(13);
    });

    it("ignores exact duplicates, preserves a complete curve, and never downgrades completed recovery", (): void => {
        const assembler = new StrokeMetricsAssembler();
        assembler.acceptBaseMetrics(base(14));
        assembler.acceptPhysicalCurve(curve(14));
        const completeUpdate = assembler.acceptCompletedMetrics(completed(14));

        expect(completeUpdate.assembly?.completedMetrics?.recovery.status).toBe("complete");
        expect(assembler.acceptPhysicalCurve(curve(14)).accepted).toBe(false);
        expect(assembler.acceptCompletedMetrics(completed(14, false)).accepted).toBe(false);
        expect(assembler.acceptPhysicalCurve(curve(14, 81)).accepted).toBe(false);

        const laterBase = assembler.acceptBaseMetrics({ ...base(14), revTime: 14_000_001 });
        expect(laterBase.assembly?.physicalCurve?.samples[0].force).toBe(80);
        expect(laterBase.assembly?.completedMetrics?.recovery.status).toBe("complete");
    });

    it("keeps late strokes associated with their own Base and resets identity at reconnect", (): void => {
        const assembler = new StrokeMetricsAssembler();
        assembler.acceptBaseMetrics(base(20));
        assembler.acceptBaseMetrics(base(21, 2_100));

        assembler.acceptCompletedMetrics(completed(20));
        const lateCurve = assembler.acceptPhysicalCurve(curve(20));
        expect(lateCurve.assembly?.sourceStrokeId).toBe(20);
        expect(lateCurve.assembly?.base.strokeCount).toBe(20);
        expect(assembler.currentStrokeId).toBe(21);

        const nextEpoch = assembler.resetSourceEpoch();
        expect(nextEpoch).toBe(1);
        expect(assembler.acceptPhysicalCurve(curve(21)).assembly).toBeUndefined();
        expect(assembler.acceptCompletedMetrics(completed(21)).assembly).toBeUndefined();

        const freshBase = assembler.acceptBaseMetrics(base(21, 2_200));
        expect(freshBase.assembly).toMatchObject({
            sourceEpoch: 1,
            sourceStrokeId: 21,
            base: { distance: 2_200 },
        });
    });

    it("advances the epoch and clears pending records when Base counters credibly reset", (): void => {
        const assembler = new StrokeMetricsAssembler();
        const resetWarning = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
        assembler.acceptBaseMetrics({
            revTime: 120_000_000,
            distance: 800_000,
            strokeTime: 100_000_000,
            strokeCount: 120,
        });
        assembler.acceptPhysicalCurve(curve(121));

        const reset = assembler.acceptBaseMetrics({
            revTime: 1_000_000,
            distance: 500,
            strokeTime: 2_000_000,
            strokeCount: 1,
        });

        expect(reset.accepted).toBe(true);
        expect(reset.assembly).toMatchObject({
            sourceEpoch: 1,
            sourceStrokeId: 1,
            base: { strokeCount: 1 },
        });
        expect(reset.assembly?.physicalCurve).toBeUndefined();
        expect(resetWarning).toHaveBeenCalledOnce();

        resetWarning.mockRestore();
    });

    it("advances epoch at natural stroke-ID wrap and carries only pending data for the wrapped ID", (): void => {
        const assembler = new StrokeMetricsAssembler();
        const wrapWarning = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
        assembler.acceptBaseMetrics({
            revTime: 1_000_000,
            distance: 100,
            strokeTime: 2_000_000,
            strokeCount: 0,
        });
        assembler.acceptCompletedMetrics(completed(0));
        assembler.acceptBaseMetrics({
            revTime: 100_000_000,
            distance: 500_000,
            strokeTime: 90_000_000,
            strokeCount: 32_760,
        });
        assembler.acceptBaseMetrics({
            revTime: 101_000_000,
            distance: 505_000,
            strokeTime: 91_000_000,
            strokeCount: 65_520,
        });
        assembler.acceptBaseMetrics({
            revTime: 101_500_000,
            distance: 507_500,
            strokeTime: 91_500_000,
            strokeCount: 0xffff,
        });
        assembler.acceptPhysicalCurve(curve(0));
        assembler.acceptCompletedMetrics({
            strokeId: 0,
            driveDurationUs: 1_000_000,
            recovery: {
                status: "complete",
                durationUs: 1_200_000,
                avgStrokePowerW: 321,
                dragFactor: 122,
            },
        });
        assembler.acceptCompletedMetrics(completed(1));

        const wrapped = assembler.acceptBaseMetrics({
            revTime: 102_000_000,
            distance: 510_000,
            strokeTime: 92_000_000,
            strokeCount: 0,
        });

        expect(wrapped.accepted).toBe(true);
        expect(wrapped.sourceEpoch).toBe(1);
        expect(wrapped.assembly).toMatchObject({
            sourceEpoch: 1,
            sourceStrokeId: 0,
            physicalCurve: { strokeId: 0 },
            completedMetrics: {
                strokeId: 0,
                recovery: { status: "complete", avgStrokePowerW: 321 },
            },
        });
        expect(wrapWarning).toHaveBeenCalledOnce();

        const nextBase = assembler.acceptBaseMetrics({
            revTime: 103_000_000,
            distance: 515_000,
            strokeTime: 93_000_000,
            strokeCount: 1,
        });
        expect(nextBase.assembly?.completedMetrics).toBeUndefined();

        wrapWarning.mockRestore();
    });

    it("does not carry an old completed stroke ID 0 across reconnect", (): void => {
        const assembler = new StrokeMetricsAssembler();
        assembler.acceptBaseMetrics(base(0));
        assembler.acceptCompletedMetrics(completed(0));
        assembler.resetSourceEpoch();
        assembler.acceptPhysicalCurve(curve(0));

        const freshBase = assembler.acceptBaseMetrics(base(0));

        expect(freshBase.assembly?.sourceEpoch).toBe(1);
        expect(freshBase.assembly?.physicalCurve?.strokeId).toBe(0);
        expect(freshBase.assembly?.completedMetrics).toBeUndefined();
    });

    it("accepts finite signed force samples from a completed curve", (): void => {
        const assembler = new StrokeMetricsAssembler();
        assembler.acceptBaseMetrics(base(22));

        const signedCurve = assembler.acceptPhysicalCurve(curve(22, -5));

        expect(signedCurve.accepted).toBe(true);
        expect(signedCurve.assembly?.physicalCurve?.samples[0].force).toBe(-5);
    });

    it("rejects non-monotonic or non-finite Base data and reports the fault", (): void => {
        const assembler = new StrokeMetricsAssembler();
        const errorSpy = vi.spyOn(console, "error").mockImplementation((): void => undefined);
        assembler.acceptBaseMetrics(base(30));

        expect(assembler.acceptBaseMetrics(base(30, 2_900)).accepted).toBe(false);
        expect(assembler.acceptBaseMetrics({ ...base(31), revTime: Number.NaN }).accepted).toBe(false);
        expect(assembler.acceptBaseMetrics({ ...base(31), revTime: 29_000_000 }).accepted).toBe(false);
        expect(errorSpy).toHaveBeenCalledTimes(3);
        expect(assembler.currentStrokeId).toBe(30);

        errorSpy.mockRestore();
    });

    it("bounds pending packets and rejects data far outside the active stroke window", (): void => {
        const assembler = new StrokeMetricsAssembler();
        for (let strokeId = 100; strokeId < 117; strokeId++) {
            assembler.acceptPhysicalCurve(curve(strokeId));
        }

        const baseUpdate = assembler.acceptBaseMetrics(base(100));
        expect(baseUpdate.assembly?.physicalCurve).toBeUndefined();
        expect(assembler.acceptPhysicalCurve(curve(200)).accepted).toBe(false);
    });
});
