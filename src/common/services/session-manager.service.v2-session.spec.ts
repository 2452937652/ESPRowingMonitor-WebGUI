import { describe, expect, it } from "vitest";

import { IRawCalculatedMetrics, ISessionCalculatedMetrics } from "../common.interfaces";

import {
    mockRawMetrics,
    setupSessionManagerTestBed,
    withSessionConfig,
} from "./session-manager.test.helpers";

describe("SessionManagerService V2 stroke identity", (): void => {
    it("starts a new session at logical zero with the current epoch and raw counters as its baseline", (): void => {
        const context = setupSessionManagerTestBed();
        context.configSubject.next(withSessionConfig({ autoSession: "off" }));
        const baseline = v2Metrics({
            sourceEpoch: 3,
            sourceStrokeId: 22,
            rawStrokeCount: 22,
            rawDistance: 20_900,
        });
        context.rawMetricsSubject.next(baseline);

        let latestMetrics: ISessionCalculatedMetrics | undefined;
        context.service.sessionMetrics$.subscribe((metrics: ISessionCalculatedMetrics): void => {
            latestMetrics = metrics;
        });

        context.service.start();

        expect(latestMetrics).toEqual(
            expect.objectContaining({
                sourceEpoch: 3,
                sourceStrokeId: 22,
                distance: 0,
                strokeCount: 0,
            }),
        );

        const firstSessionStroke = v2Metrics({
            sourceEpoch: 3,
            sourceStrokeId: 23,
            rawStrokeCount: 23,
            rawDistance: 21_850,
            distPerStroke: 9.5,
        });
        emitCurrent(context, firstSessionStroke);

        expect(latestMetrics).toEqual(
            expect.objectContaining({
                sourceEpoch: 3,
                sourceStrokeId: 23,
                distance: 950,
                strokeCount: 1,
            }),
        );
        expect(context.mockDataRecorderService.upsertSessionStroke).toHaveBeenCalledWith(
            expect.objectContaining({ distance: 950, strokeCount: 1, sourceEpoch: 3, sourceStrokeId: 23 }),
            expect.objectContaining({ sourceEpoch: 3, sourceStrokeId: 23 }),
        );
        expect(context.mockDataRecorderService.addSessionData).not.toHaveBeenCalled();
    });

    it("includes one trigger stroke when auto-start first observes a high device counter", (): void => {
        const context = setupSessionManagerTestBed();
        const firstObservedStroke = v2Metrics({
            sourceEpoch: 4,
            sourceStrokeId: 22,
            rawStrokeCount: 22,
            rawDistance: 20_900,
            distPerStroke: 9.5,
        });
        let latestMetrics: ISessionCalculatedMetrics | undefined;
        context.service.sessionMetrics$.subscribe((metrics: ISessionCalculatedMetrics): void => {
            latestMetrics = metrics;
        });

        emitCurrent(context, firstObservedStroke);

        expect(context.service.sessionState()).toBe("running");
        expect(latestMetrics).toEqual(
            expect.objectContaining({
                sourceEpoch: 4,
                sourceStrokeId: 22,
                distance: 950,
                strokeCount: 1,
            }),
        );
        expect(context.mockDataRecorderService.upsertSessionStroke).toHaveBeenCalledTimes(1);
    });

    it("applies a late completed supplement to its keyed row without moving the active stroke backward", (): void => {
        const context = setupSessionManagerTestBed();
        context.configSubject.next(withSessionConfig({ autoSession: "off" }));
        context.rawMetricsSubject.next(
            v2Metrics({
                sourceEpoch: 5,
                sourceStrokeId: 9,
                rawStrokeCount: 9,
                rawDistance: 8_550,
            }),
        );
        let latestMetrics: ISessionCalculatedMetrics | undefined;
        context.service.sessionMetrics$.subscribe((metrics: ISessionCalculatedMetrics): void => {
            latestMetrics = metrics;
        });
        let display: ISessionCalculatedMetrics | undefined;
        context.service.displayMetrics$.subscribe((value: ISessionCalculatedMetrics): void => {
            display = value;
        });
        context.service.start();

        const stroke10 = v2Metrics({
            sourceEpoch: 5,
            sourceStrokeId: 10,
            rawStrokeCount: 10,
            rawDistance: 9_500,
            distPerStroke: 9.5,
        });
        emitCurrent(context, stroke10);
        const stroke11 = v2Metrics({
            sourceEpoch: 5,
            sourceStrokeId: 11,
            rawStrokeCount: 11,
            rawDistance: 10_450,
            distPerStroke: 9.5,
        });
        emitCurrent(context, stroke11);

        const completedLateStroke10 = v2Metrics({
            ...stroke10,
            isExtendedMetricsPending: false,
            avgStrokePower: 100,
            driveDuration: 0.5,
            recoveryDuration: 0.6,
            dragFactor: 120,
            forceCurve: {
                strokeId: 10,
                driveLength: 1.25,
                driveDurationUs: 500_000,
                samples: [
                    { distance: 0, elapsedTimeUs: 0, force: 0 },
                    { distance: 1.25, elapsedTimeUs: 500_000, force: 240 },
                ],
            },
            forceCurveStatus: "complete",
            forceCurveStrokeId: 10,
            handleForces: [0, 240],
            peakForce: 240,
        });
        context.strokeMetricUpdatesSubject.next(completedLateStroke10);
        expect(display).toMatchObject({
            sourceStrokeId: 11,
            strokeCount: 2,
            recoveryDuration: 0.6,
            avgStrokePower: 100,
            isExtendedMetricsPending: false,
        });
        expect(latestMetrics?.isExtendedMetricsPending).toBe(true);

        expect(latestMetrics).toEqual(
            expect.objectContaining({
                sourceEpoch: 5,
                sourceStrokeId: 11,
                distance: 1_900,
                strokeCount: 2,
                isExtendedMetricsPending: true,
                forceCurveStatus: "pending",
                displayForceCurve: expect.objectContaining({ strokeId: 10, driveLength: 1.25 }),
            }),
        );
        expect(latestMetrics?.totalWork).toBeCloseTo(110, 8);
        expect(context.mockDataRecorderService.upsertSessionStroke).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sourceEpoch: 5,
                sourceStrokeId: 10,
                strokeCount: 1,
                isExtendedMetricsPending: false,
                forceCurveStatus: "complete",
                forceCurve: expect.objectContaining({ strokeId: 10 }),
            }),
            expect.objectContaining({
                sourceEpoch: 5,
                sourceStrokeId: 10,
                forceCurve: expect.objectContaining({ strokeId: 10 }),
            }),
        );
        expect(context.mockDataRecorderService.upsertSessionStroke).not.toHaveBeenLastCalledWith(
            expect.objectContaining({ displayForceCurve: expect.anything() }),
            expect.anything(),
        );
    });

    it("treats an unchanged reconnect Base as a baseline and counts the next stroke once", (): void => {
        const context = setupSessionManagerTestBed();
        context.configSubject.next(withSessionConfig({ autoSession: "off" }));
        context.rawMetricsSubject.next(
            v2Metrics({ sourceEpoch: 7, sourceStrokeId: 0, rawStrokeCount: 0, rawDistance: 0 }),
        );
        let latestMetrics: ISessionCalculatedMetrics | undefined;
        context.service.sessionMetrics$.subscribe((metrics: ISessionCalculatedMetrics): void => {
            latestMetrics = metrics;
        });
        context.service.start();

        emitCurrent(
            context,
            v2Metrics({
                sourceEpoch: 7,
                sourceStrokeId: 1,
                rawStrokeCount: 1,
                rawDistance: 950,
                distPerStroke: 9.5,
            }),
        );
        emitCurrent(
            context,
            v2Metrics({
                sourceEpoch: 8,
                sourceStrokeId: 1,
                rawStrokeCount: 1,
                rawDistance: 950,
                distPerStroke: 0,
            }),
        );

        expect(latestMetrics).toEqual(
            expect.objectContaining({ sourceEpoch: 8, sourceStrokeId: 1, strokeCount: 1, distance: 950 }),
        );
        expect(context.mockDataRecorderService.upsertSessionStroke).toHaveBeenCalledTimes(1);

        emitCurrent(
            context,
            v2Metrics({
                sourceEpoch: 8,
                sourceStrokeId: 2,
                rawStrokeCount: 2,
                rawDistance: 1_900,
                distPerStroke: 9.5,
            }),
        );

        expect(latestMetrics).toEqual(
            expect.objectContaining({ sourceEpoch: 8, sourceStrokeId: 2, strokeCount: 2, distance: 1_900 }),
        );
        expect(context.mockDataRecorderService.upsertSessionStroke).toHaveBeenCalledTimes(2);
    });

    it("rebases a reset device counter on reconnect without copying historical distance", (): void => {
        const context = setupSessionManagerTestBed();
        context.configSubject.next(withSessionConfig({ autoSession: "off" }));
        context.rawMetricsSubject.next(
            v2Metrics({ sourceEpoch: 7, sourceStrokeId: 10, rawStrokeCount: 10, rawDistance: 9_500 }),
        );
        let latestMetrics: ISessionCalculatedMetrics | undefined;
        context.service.sessionMetrics$.subscribe((metrics: ISessionCalculatedMetrics): void => {
            latestMetrics = metrics;
        });
        context.service.start();

        emitCurrent(
            context,
            v2Metrics({ sourceEpoch: 8, sourceStrokeId: 1, rawStrokeCount: 1, rawDistance: 950 }),
        );

        expect(latestMetrics).toEqual(expect.objectContaining({ strokeCount: 0, distance: 0 }));
        expect(context.mockDataRecorderService.upsertSessionStroke).not.toHaveBeenCalled();

        emitCurrent(
            context,
            v2Metrics({ sourceEpoch: 8, sourceStrokeId: 2, rawStrokeCount: 2, rawDistance: 1_900 }),
        );

        expect(latestMetrics).toEqual(expect.objectContaining({ strokeCount: 1, distance: 950 }));
        expect(context.mockDataRecorderService.upsertSessionStroke).toHaveBeenCalledTimes(1);
    });

    it("does not auto-start from a reconnect epoch with an unchanged device stroke count", (): void => {
        const context = setupSessionManagerTestBed();
        context.configSubject.next(withSessionConfig({ autoSession: "off" }));
        context.rawMetricsSubject.next(
            v2Metrics({ sourceEpoch: 4, sourceStrokeId: 12, rawStrokeCount: 12, rawDistance: 11_400 }),
        );
        context.configSubject.next(withSessionConfig({ autoSession: "autoStartAndPause" }));

        emitCurrent(
            context,
            v2Metrics({ sourceEpoch: 5, sourceStrokeId: 12, rawStrokeCount: 12, rawDistance: 11_400 }),
        );

        expect(context.service.sessionState()).toBe("stopped");
    });

    it("counts device strokes missed during a disconnect in the session total", (): void => {
        const context = setupSessionManagerTestBed();
        context.configSubject.next(withSessionConfig({ autoSession: "off" }));
        context.rawMetricsSubject.next(
            v2Metrics({ sourceEpoch: 7, sourceStrokeId: 1, rawStrokeCount: 1, rawDistance: 950 }),
        );
        let latestMetrics: ISessionCalculatedMetrics | undefined;
        context.service.sessionMetrics$.subscribe((metrics: ISessionCalculatedMetrics): void => {
            latestMetrics = metrics;
        });
        context.service.start();

        emitCurrent(
            context,
            v2Metrics({ sourceEpoch: 7, sourceStrokeId: 2, rawStrokeCount: 2, rawDistance: 1_900 }),
        );
        emitCurrent(
            context,
            v2Metrics({
                sourceEpoch: 8,
                sourceStrokeId: 5,
                rawStrokeCount: 5,
                rawDistance: 4_750,
                distPerStroke: 0,
            }),
        );

        expect(latestMetrics).toEqual(
            expect.objectContaining({ sourceEpoch: 8, strokeCount: 4, distance: 3_800 }),
        );
        expect(context.mockDataRecorderService.upsertSessionStroke).toHaveBeenCalledTimes(2);
        expect(context.mockDataRecorderService.upsertSessionStroke).toHaveBeenLastCalledWith(
            expect.objectContaining({ strokeCount: 4, distance: 3_800, sourceEpoch: 8, sourceStrokeId: 5 }),
            expect.anything(),
        );
    });
});

function emitCurrent(
    context: ReturnType<typeof setupSessionManagerTestBed>,
    metrics: IRawCalculatedMetrics,
): void {
    context.rawMetricsSubject.next(metrics);
    context.strokeMetricUpdatesSubject.next(metrics);
}

function v2Metrics(overrides: Partial<IRawCalculatedMetrics>): IRawCalculatedMetrics {
    return {
        ...mockRawMetrics,
        sourceEpoch: 0,
        sourceStrokeId: 0,
        forceCurveStatus: "pending",
        isExtendedMetricsPending: true,
        ...overrides,
    };
}
