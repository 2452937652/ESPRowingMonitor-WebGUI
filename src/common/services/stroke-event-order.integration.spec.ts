import { signal, WritableSignal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { MatSnackBar } from "@angular/material/snack-bar";
import { BehaviorSubject, Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    Config,
    IBaseMetrics,
    IErgConnectionStatus,
    IExtendedMetrics,
    IForceCurve,
    IHeartRate,
    IHRConnectionStatus,
    ICalculatedMetrics,
    IRowerSettings,
} from "../common.interfaces";

import { ConfigManagerService } from "./config-manager.service";
import { DataRecorderService } from "./data-recorder.service";
import { ErgConnectionService } from "./ergometer/erg-connection.service";
import { ErgMetricsService } from "./ergometer/erg-metric-data.service";
import { ErgSettingsService } from "./ergometer/erg-settings.service";
import { createMockRowerSettings } from "./ergometer/erg-settings.test.helpers";
import { HeartRateService } from "./heart-rate/heart-rate.service";
import { IntervalsIcuService } from "./intervals-icu.service";
import { MetricsService } from "./metrics.service";
import { SessionManagerService } from "./session-manager.service";

describe("stroke event ordering integration", (): void => {
    let metricsService: MetricsService;
    let sessionManager: SessionManagerService;
    let measurementSubject: Subject<IBaseMetrics>;
    let extendedSubject: Subject<IExtendedMetrics>;
    let handleForcesSubject: Subject<Array<number>>;
    let forceCurveSubject: Subject<IForceCurve>;
    let forceCurveSupportSubject: BehaviorSubject<boolean>;
    let connectionStatusSubject: BehaviorSubject<IErgConnectionStatus>;
    let heartRateSubject: BehaviorSubject<IHeartRate | undefined>;
    let configSubject: BehaviorSubject<Config>;
    let rowerSettings: WritableSignal<IRowerSettings>;
    let recordedSessionData: Array<Record<string, unknown>>;

    beforeEach((): void => {
        vi.stubGlobal("isSecureContext", false);
        measurementSubject = new Subject<IBaseMetrics>();
        extendedSubject = new Subject<IExtendedMetrics>();
        handleForcesSubject = new Subject<Array<number>>();
        forceCurveSubject = new Subject<IForceCurve>();
        forceCurveSupportSubject = new BehaviorSubject<boolean>(false);
        heartRateSubject = new BehaviorSubject<IHeartRate | undefined>(undefined);
        configSubject = new BehaviorSubject<Config>(new Config());
        rowerSettings = signal<IRowerSettings>(createMockRowerSettings());
        recordedSessionData = [];

        connectionStatusSubject = new BehaviorSubject<IErgConnectionStatus>({ status: "disconnected" });
        const hrConnectionStatusSubject = new BehaviorSubject<IHRConnectionStatus>({ status: "disconnected" });
        const mockDataRecorder = {
            currentSessionId: 1,
            addConnectedDevice: vi.fn().mockResolvedValue(1),
            addDeltaTimes: vi.fn().mockResolvedValue(1),
            addLap: vi.fn().mockResolvedValue(1),
            addSessionData: vi.fn((data: Record<string, unknown>): Promise<void> => {
                recordedSessionData.push(data);

                return Promise.resolve();
            }),
            reset: vi.fn().mockResolvedValue(undefined),
        };
        const mockErgConnection = {
            reconnect: vi.fn(),
            connectionStatus$: vi.fn().mockReturnValue(connectionStatusSubject.asObservable()),
        };
        const mockErgMetrics = {
            streamMeasurement$: vi.fn().mockReturnValue(measurementSubject.asObservable()),
            streamExtended$: vi.fn().mockReturnValue(extendedSubject.asObservable()),
            streamHandleForces$: vi.fn().mockReturnValue(handleForcesSubject.asObservable()),
            streamHandleForceCurve$: vi.fn().mockReturnValue(forceCurveSubject.asObservable()),
            streamHandleForceCurveSupport$: vi.fn().mockReturnValue(forceCurveSupportSubject.asObservable()),
            streamDeltaTimes$: vi.fn().mockReturnValue(new Subject<Array<number>>().asObservable()),
        };
        const mockErgSettings = { rowerSettings };
        const mockHeartRate = {
            streamHeartRate$: vi.fn().mockReturnValue(heartRateSubject.asObservable()),
            connectionStatus$: vi.fn().mockReturnValue(hrConnectionStatusSubject.asObservable()),
        };
        const mockConfigManager = {
            configChanged$: configSubject.asObservable(),
            getGroup: vi.fn().mockReturnValue({
                intervalsIcu: { apiKey: "", athleteId: "", autoUploadEnabled: false },
            }),
        };

        TestBed.configureTestingModule({
            providers: [
                MetricsService,
                SessionManagerService,
                { provide: DataRecorderService, useValue: mockDataRecorder },
                { provide: ErgConnectionService, useValue: mockErgConnection },
                { provide: ErgMetricsService, useValue: mockErgMetrics },
                { provide: ErgSettingsService, useValue: mockErgSettings },
                { provide: HeartRateService, useValue: mockHeartRate },
                { provide: ConfigManagerService, useValue: mockConfigManager },
                { provide: IntervalsIcuService, useValue: { uploadSession: vi.fn().mockResolvedValue(true) } },
                { provide: MatSnackBar, useValue: { open: vi.fn() } },
            ],
        });

        metricsService = TestBed.inject(MetricsService);
        sessionManager = TestBed.inject(SessionManagerService);
    });

    afterEach((): void => {
        sessionManager.stop();
        TestBed.resetTestingModule();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("updates the same recorded stroke when its physical curve arrives after base metrics", (): void => {
        const emitted = subscribeToSession(sessionManager);
        sessionManager.start();

        handleForcesSubject.next([10, 20]);
        extendedSubject.next({
            avgStrokePower: 0,
            driveDuration: 0,
            recoveryDuration: 0,
            dragFactor: 0,
        });
        measurementSubject.next(baseMetrics(41));
        measurementSubject.next(baseMetrics(42));

        const curve = physicalCurve(42);
        forceCurveSubject.next(curve);

        expect(latestSessionMetrics(emitted)).toMatchObject({
            strokeCount: 42,
            driveLength: curve.driveLength,
            forceCurve: curve.samples,
        });

    });

    it("joins a complete curve that arrives before the base metrics for its stroke", (): void => {
        const emitted = subscribeToSession(sessionManager);
        const curve = physicalCurve(6);
        sessionManager.start();

        forceCurveSubject.next(curve);
        measurementSubject.next(baseMetrics(6));

        expect(latestSessionMetrics(emitted)).toMatchObject({
            strokeCount: 6,
            forceCurveStrokeId: 6,
            driveLength: 1.4,
            forceCurve: curve.samples,
            forceCurveStatus: "complete",
        });
    });

    it("keeps recovery-derived fields pending and updates late power/time on the same stroke without cumulative work duplication", (): void => {
        const emitted = subscribeToSession(sessionManager);
        sessionManager.start();
        measurementSubject.next(baseMetrics(9));

        expect(latestSessionMetrics(emitted)).toMatchObject({
            strokeCount: 9,
            isExtendedMetricsPending: true,
            totalWork: 0,
        });

        const pending: IExtendedMetrics = {
            avgStrokePower: 0,
            driveDuration: 1_250_000,
            recoveryDuration: 0,
            dragFactor: 123,
            strokeId: 9,
            recoveryMetricsComplete: false,
        };
        extendedSubject.next(pending);
        expect(latestSessionMetrics(emitted)).toMatchObject({
            strokeCount: 9,
            isExtendedMetricsPending: true,
            totalWork: 0,
        });

        const update: IExtendedMetrics = {
            ...pending,
            avgStrokePower: 333,
            recoveryDuration: 2_750_000,
            recoveryMetricsComplete: true,
        };
        extendedSubject.next(update);
        extendedSubject.next(update);

        expect(latestSessionMetrics(emitted)).toMatchObject({
            strokeCount: 9,
            avgStrokePower: 333,
            driveDuration: 1.25,
            recoveryDuration: 2.75,
            dragFactor: 123,
            isExtendedMetricsPending: false,
            totalWork: 1332,
        });
        expect(new Set(recordedSessionData.map((data: Record<string, unknown>): unknown => data.strokeCount))).toEqual(
            new Set([9]),
        );
    });

    it("keeps the prior completed curve on screen while the next V2 stroke is pending without recording it as new", (): void => {
        const emitted = subscribeToSession(sessionManager);
        const curve = physicalCurve(1);
        sessionManager.start();
        measurementSubject.next(baseMetrics(1));
        forceCurveSubject.next(curve);
        measurementSubject.next(baseMetrics(2));

        const current = latestSessionMetrics(emitted);
        expect(current).toMatchObject({
            strokeCount: 2,
            driveLength: 0,
            forceCurveStatus: "pending",
            displayForceCurve: { strokeId: 1, samples: curve.samples },
        });
        const newStrokeWrite = recordedSessionData.at(-1);
        expect(newStrokeWrite).toMatchObject({ strokeCount: 2, handleForces: [] });
        expect(newStrokeWrite?.forceCurve).toBeUndefined();
    });

    it("marks a missing V2 curve as pending rather than treating zero length as a valid curve", (): void => {
        const emitted = subscribeToSession(sessionManager);
        sessionManager.start();
        forceCurveSupportSubject.next(true);
        measurementSubject.next(baseMetrics(11));

        expect(latestSessionMetrics(emitted)).toMatchObject({
            strokeCount: 11,
            driveLength: 0,
            forceCurveStatus: "pending",
        });
        expect(latestSessionMetrics(emitted).forceCurve).toBeUndefined();
    });

    it("does not allow legacy arrays to overwrite a V2 stroke while preserving legacy-only compatibility", (): void => {
        const emitted = subscribeToSession(sessionManager);
        sessionManager.start();
        measurementSubject.next(baseMetrics(13));
        handleForcesSubject.next([10, 20, 30]);
        extendedSubject.next({ avgStrokePower: 200, driveDuration: 800_000, recoveryDuration: 1200_000, dragFactor: 100 });

        expect(latestSessionMetrics(emitted).forceCurveStatus).toBe("legacy");
        expect(latestSessionMetrics(emitted).handleForces).toEqual([10, 20, 30]);

        forceCurveSupportSubject.next(true);
        handleForcesSubject.next([999]);

        expect(latestSessionMetrics(emitted)).toMatchObject({ forceCurveStatus: "pending", handleForces: [] });
    });

    it("drops stale curves across a disconnect/reset before accepting the new device stroke epoch", (): void => {
        const emitted = subscribeToSession(sessionManager);
        sessionManager.start();
        measurementSubject.next(baseMetrics(8));
        forceCurveSubject.next(physicalCurve(8));

        connectionStatusSubject.next({ status: "connected", deviceName: "ESP Rowing Monitor" });
        connectionStatusSubject.next({ status: "disconnected" });
        // A queued old notification must not be associated with a reused stroke number after reboot.
        forceCurveSubject.next(physicalCurve(1));
        measurementSubject.next(baseMetrics(1));

        expect(latestSessionMetrics(emitted)).toMatchObject({
            strokeCount: 9,
            forceCurveStatus: "pending",
        });
        expect(latestSessionMetrics(emitted).forceCurve).toBeUndefined();

        const freshCurve = physicalCurve(1);
        forceCurveSubject.next(freshCurve);
        expect(latestSessionMetrics(emitted)).toMatchObject({
            strokeCount: 9,
            forceCurveStrokeId: 1,
            forceCurve: freshCurve.samples,
        });
    });

    it("does not create another session stroke for a duplicate curve notification", (): void => {
        const emitted = subscribeToSession(sessionManager);
        sessionManager.start();
        measurementSubject.next(baseMetrics(16));
        const curve = physicalCurve(16);
        forceCurveSubject.next(curve);
        forceCurveSubject.next(curve);

        expect(latestSessionMetrics(emitted)).toMatchObject({ strokeCount: 16, forceCurve: curve.samples });
        expect(recordedSessionData.every((data: Record<string, unknown>): boolean => data.strokeCount === 16)).toBe(
            true,
        );
    });
});

function subscribeToSession(manager: SessionManagerService): Array<ICalculatedMetrics> {
    const emitted: Array<ICalculatedMetrics> = [];
    manager.sessionMetrics$.subscribe((metrics: ICalculatedMetrics): void => {
        emitted.push(metrics);
    });

    return emitted;
}

function baseMetrics(strokeCount: number): IBaseMetrics {
    return {
        distance: strokeCount * 100,
        revTime: strokeCount * 1_000_000,
        strokeCount,
        strokeTime: strokeCount * 2_000_000,
    };
}

function physicalCurve(strokeId: number): IForceCurve {
    return {
        strokeId,
        driveLength: 1.4,
        driveDuration: 1.2,
        samples: [
            { distance: 0, elapsedTime: 0, force: 12 },
            { distance: 0.7, elapsedTime: 0.6, force: 98 },
            { distance: 1.4, elapsedTime: 1.2, force: 0 },
        ],
    };
}

function latestSessionMetrics<T>(emitted: Array<T>): T {
    const latest = emitted.at(-1);
    if (latest === undefined) {
        throw new Error("The session did not emit metrics");
    }

    return latest;
}
