import { signal, WritableSignal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BehaviorSubject, firstValueFrom, Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, Mock, vi } from "vitest";

import {
    IBaseMetrics,
    IErgConnectionStatus,
    IExtendedMetrics,
    IHeartRate,
    IHRConnectionStatus,
    IRawCalculatedMetrics,
    IRowerSettings,
} from "../common.interfaces";

import { DataRecorderService } from "./data-recorder.service";
import { ICompletedStrokeMetricsV2 } from "./ergometer/completed-stroke-v2-decoder";
import { ErgConnectionService } from "./ergometer/erg-connection.service";
import { ErgMetricsService } from "./ergometer/erg-metric-data.service";
import { ErgSettingsService } from "./ergometer/erg-settings.service";
import { createMockRowerSettings } from "./ergometer/erg-settings.test.helpers";
import { IPhysicalForceCurveV2 } from "./ergometer/physical-force-curve-v2-decoder";
import { HeartRateService } from "./heart-rate/heart-rate.service";
import { MetricsService } from "./metrics.service";

describe("MetricsService", (): void => {
    let service: MetricsService;
    let mockErgConnectionService: Pick<
        ErgConnectionService,
        | "reconnect"
        | "connectionStatus$"
        | "physicalForceCurveV2Characteristic$"
        | "completedStrokeMetricsV2Characteristic$"
    >;
    let mockErgMetricsService: Pick<
        ErgMetricsService,
        | "streamMeasurement$"
        | "streamExtended$"
        | "streamHandleForces$"
        | "streamDeltaTimes$"
        | "streamPhysicalForceCurveV2$"
        | "streamCompletedStrokeMetricsV2$"
    >;
    let mockDataRecorderService: Pick<DataRecorderService, "addDeltaTimes" | "addConnectedDevice">;
    let mockHeartRateService: Pick<HeartRateService, "streamHeartRate$" | "connectionStatus$">;
    let mockErgSettingsService: Pick<ErgSettingsService, "rowerSettings">;
    let mockRowerSettingsSignal: WritableSignal<IRowerSettings>;

    let connectionStatusSubject: BehaviorSubject<IErgConnectionStatus>;
    let measurementSubject: Subject<IBaseMetrics>;
    let extendedSubject: Subject<IExtendedMetrics>;
    let handleForcesSubject: Subject<Array<number>>;
    let physicalForceCurveV2Subject: Subject<IPhysicalForceCurveV2>;
    let completedStrokeMetricsV2Subject: Subject<ICompletedStrokeMetricsV2>;
    let physicalForceCurveV2CharacteristicSubject: BehaviorSubject<
        BluetoothRemoteGATTCharacteristic | undefined
    >;
    let completedStrokeMetricsV2CharacteristicSubject: BehaviorSubject<
        BluetoothRemoteGATTCharacteristic | undefined
    >;
    let deltaTimesSubject: Subject<Array<number>>;
    let heartRateSubject: Subject<IHeartRate | undefined>;
    let hrConnectionStatusSubject: Subject<IHRConnectionStatus>;

    const mockBaseMetrics: IBaseMetrics = {
        revTime: 1000000,
        distance: 1000,
        strokeTime: 2000000,
        strokeCount: 10,
    };

    const mockExtendedMetrics: IExtendedMetrics = {
        avgStrokePower: 100,
        driveDuration: 1000000,
        recoveryDuration: 2000000,
        dragFactor: 120,
    };

    const mockConnectionStatus: IErgConnectionStatus = {
        status: "connected",
        deviceName: "Test Device",
    };

    const mockHeartRate: IHeartRate = {
        heartRate: 150,
        rrIntervals: [800],
        contactDetected: true,
    };

    const mockHRConnectionStatus: IHRConnectionStatus = {
        status: "connected",
        deviceName: "HR Monitor",
    };

    let isSecureContextSpy: Mock;
    let navigatorSpy: Mock;

    beforeEach((): void => {
        if (!("isSecureContext" in globalThis)) {
            Object.defineProperty(globalThis, "isSecureContext", {
                configurable: true,
                get: (): boolean => false,
            });
        }
        isSecureContextSpy = vi.spyOn(globalThis, "isSecureContext", "get").mockReturnValue(false);
        navigatorSpy = vi.spyOn(globalThis, "navigator", "get").mockReturnValue({} as Navigator);

        connectionStatusSubject = new BehaviorSubject<IErgConnectionStatus>({ status: "connected" });
        measurementSubject = new Subject<IBaseMetrics>();
        extendedSubject = new Subject<IExtendedMetrics>();
        handleForcesSubject = new Subject<Array<number>>();
        physicalForceCurveV2Subject = new Subject<IPhysicalForceCurveV2>();
        completedStrokeMetricsV2Subject = new Subject<ICompletedStrokeMetricsV2>();
        physicalForceCurveV2CharacteristicSubject = new BehaviorSubject<
            BluetoothRemoteGATTCharacteristic | undefined
        >(undefined);
        completedStrokeMetricsV2CharacteristicSubject = new BehaviorSubject<
            BluetoothRemoteGATTCharacteristic | undefined
        >(undefined);
        deltaTimesSubject = new Subject<Array<number>>();
        heartRateSubject = new Subject<IHeartRate | undefined>();
        hrConnectionStatusSubject = new Subject<IHRConnectionStatus>();

        mockErgConnectionService = {
            reconnect: vi.fn(),
            connectionStatus$: vi.fn().mockReturnValue(connectionStatusSubject.asObservable()),
            physicalForceCurveV2Characteristic$: physicalForceCurveV2CharacteristicSubject.asObservable(),
            completedStrokeMetricsV2Characteristic$:
                completedStrokeMetricsV2CharacteristicSubject.asObservable(),
        };

        mockErgMetricsService = {
            streamMeasurement$: vi.fn().mockReturnValue(measurementSubject.asObservable()),
            streamExtended$: vi.fn().mockReturnValue(extendedSubject.asObservable()),
            streamHandleForces$: vi.fn().mockReturnValue(handleForcesSubject.asObservable()),
            streamDeltaTimes$: vi.fn().mockReturnValue(deltaTimesSubject.asObservable()),
            streamPhysicalForceCurveV2$: vi.fn().mockReturnValue(physicalForceCurveV2Subject.asObservable()),
            streamCompletedStrokeMetricsV2$: vi
                .fn()
                .mockReturnValue(completedStrokeMetricsV2Subject.asObservable()),
        };

        mockDataRecorderService = {
            addDeltaTimes: vi.fn(),
            addConnectedDevice: vi.fn(),
        };

        mockHeartRateService = {
            streamHeartRate$: vi.fn().mockReturnValue(heartRateSubject.asObservable()),
            connectionStatus$: vi.fn().mockReturnValue(hrConnectionStatusSubject.asObservable()),
        };

        mockRowerSettingsSignal = signal<IRowerSettings>(createMockRowerSettings());

        mockErgSettingsService = {
            rowerSettings: mockRowerSettingsSignal,
        };

        TestBed.configureTestingModule({
            providers: [
                MetricsService,
                { provide: ErgConnectionService, useValue: mockErgConnectionService },
                { provide: ErgMetricsService, useValue: mockErgMetricsService },
                { provide: ErgSettingsService, useValue: mockErgSettingsService },
                { provide: DataRecorderService, useValue: mockDataRecorderService },
                { provide: HeartRateService, useValue: mockHeartRateService },
            ],
        });
    });

    afterEach((): void => {
        vi.resetAllMocks();
    });

    describe("Service Initialization", (): void => {
        it("should instantiate the service and initialize all observables", (): void => {
            service = TestBed.inject(MetricsService);

            expect(service).toBeTruthy();
            expect(service.rawMetrics$).toBeDefined();
            expect(service.heartRateData$).toBeDefined();
            expect(service.hrConnectionStatus$).toBeDefined();
        });

        it("should call ergConnectionService.reconnect() if running in a secure context with Bluetooth available", (): void => {
            isSecureContextSpy.mockReturnValue(true);
            navigatorSpy.mockReturnValue({ bluetooth: {} } as Navigator);

            service = TestBed.inject(MetricsService);

            expect(mockErgConnectionService.reconnect).toHaveBeenCalled();
        });

        it("should not call ergConnectionService.reconnect() if not in a secure context", (): void => {
            isSecureContextSpy.mockReturnValue(false);
            navigatorSpy.mockReturnValue({ bluetooth: {} } as Navigator);

            service = TestBed.inject(MetricsService);

            expect(mockErgConnectionService.reconnect).not.toHaveBeenCalled();
        });

        it("should not call ergConnectionService.reconnect() if Bluetooth is unavailable", (): void => {
            isSecureContextSpy.mockReturnValue(true);
            navigatorSpy.mockReturnValue({} as Navigator);

            service = TestBed.inject(MetricsService);

            expect(mockErgConnectionService.reconnect).not.toHaveBeenCalled();
        });
    });

    describe("legacy stream regression", (): void => {
        it("retains stroke metrics during wheel updates and measures the full next cycle", (): void => {
            service = TestBed.inject(MetricsService);
            const output: Array<IRawCalculatedMetrics> = [];
            const sub = service.rawMetrics$.subscribe((value: IRawCalculatedMetrics): void => {
                output.push(value);
            });
            measurementSubject.next({ distance: 0, revTime: 0, strokeCount: 0, strokeTime: 0 });
            extendedSubject.next(mockExtendedMetrics);
            measurementSubject.next({ distance: 800, revTime: 2e6, strokeCount: 1, strokeTime: 3e6 });
            measurementSubject.next({ distance: 1300, revTime: 4e6, strokeCount: 1, strokeTime: 3e6 });
            expect(output.at(-1)).toMatchObject({ strokeRate: 20, distPerStroke: 8 });
            measurementSubject.next({ distance: 1700, revTime: 5e6, strokeCount: 2, strokeTime: 6e6 });
            expect(output.at(-1)).toMatchObject({ strokeRate: 20, distPerStroke: 9 });
            measurementSubject.next({ distance: 1700, revTime: 5e6, strokeCount: 2, strokeTime: 6e6 });
            expect(output.at(-1)).toMatchObject({ strokeRate: 0, distPerStroke: 9 });
            sub.unsubscribe();
        });

        it("updates drive length when machine settings arrive after the force array", (): void => {
            service = TestBed.inject(MetricsService);
            const configured = createMockRowerSettings({ sprocketRadius: 1.5, impulsePerRevolution: 6 });
            mockRowerSettingsSignal.set({
                ...configured,
                rowingSettings: {
                    ...configured.rowingSettings,
                    machineSettings: {
                        ...configured.rowingSettings.machineSettings,
                        sprocketRadius: 0,
                        impulsePerRevolution: 0,
                    },
                },
            });
            const output: Array<IRawCalculatedMetrics> = [];
            const sub = service.rawMetrics$.subscribe((value: IRawCalculatedMetrics): void => {
                output.push(value);
            });
            measurementSubject.next(mockBaseMetrics);
            handleForcesSubject.next([10, 20, 10]);
            measurementSubject.next({ ...mockBaseMetrics, strokeCount: 11, distance: 1100 });
            expect(output.at(-1)?.driveLength).toBe(0);
            mockRowerSettingsSignal.set(configured);
            TestBed.tick();
            expect(output.at(-1)!.driveLength).toBeGreaterThan(0);
            sub.unsubscribe();
        });

        it("keeps official extended data available when only one optional V2 service exists", (): void => {
            physicalForceCurveV2CharacteristicSubject.next({} as BluetoothRemoteGATTCharacteristic);
            service = TestBed.inject(MetricsService);
            const output: Array<IRawCalculatedMetrics> = [];
            const sub = service.rawMetrics$.subscribe((value: IRawCalculatedMetrics): void => {
                output.push(value);
            });
            measurementSubject.next(mockBaseMetrics);
            extendedSubject.next(mockExtendedMetrics);
            measurementSubject.next({ ...mockBaseMetrics, strokeCount: 11, distance: 1100 });
            expect(output.at(-1)).toMatchObject({ recoveryDuration: 2, avgStrokePower: 100 });
            expect(output.at(-1)?.sourceEpoch).toBeUndefined();
            sub.unsubscribe();
        });
    });

    describe("Calculation Methods", (): void => {
        beforeEach((): void => {
            service = TestBed.inject(MetricsService);
        });

        it("should calculate speed correctly based on distance and time changes", async (): Promise<void> => {
            const baseMetrics1: IBaseMetrics = {
                revTime: 1000000,
                distance: 1000,
                strokeTime: 0,
                strokeCount: 0,
            };
            const baseMetrics2: IBaseMetrics = {
                revTime: 2000000,
                distance: 2000,
                strokeTime: 0,
                strokeCount: 0,
            };

            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                // speed = (distance_diff / 100) / (time_diff / 1e6)
                // expected: (1000 / 100) / ((2000000 - 1000000) / 1e6) = 10 / 1 = 10 m/s
                expect(metrics.speed).toBe(10);
            });

            measurementSubject.next(baseMetrics1);
            measurementSubject.next(baseMetrics2);
        });

        it("should calculate stroke distance correctly", async (): Promise<void> => {
            const baseMetrics1: IBaseMetrics = { revTime: 0, distance: 1000, strokeTime: 0, strokeCount: 1 };
            const baseMetrics2: IBaseMetrics = { revTime: 0, distance: 2000, strokeTime: 0, strokeCount: 2 };

            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                // distPerStroke = (distance_diff / 100) / stroke_diff
                // expected: (1000 / 100) / 1 = 10 m/stroke
                expect(metrics.distPerStroke).toBe(10);
            });

            measurementSubject.next(baseMetrics1);
            measurementSubject.next(baseMetrics2);
        });

        it("should calculate stroke rate correctly", async (): Promise<void> => {
            const baseMetrics1: IBaseMetrics = {
                revTime: 0,
                distance: 0,
                strokeTime: 1000000,
                strokeCount: 1,
            };
            const baseMetrics2: IBaseMetrics = {
                revTime: 0,
                distance: 0,
                strokeTime: 2000000,
                strokeCount: 2,
            };

            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                // strokeRate = (stroke_diff / (time_diff / 1e6)) * 60
                // expected: (1 / ((2000000 - 1000000) / 1e6)) * 60 = (1 / 1) * 60 = 60 strokes/min
                expect(metrics.strokeRate).toBe(60);
            });

            measurementSubject.next(baseMetrics1);
            measurementSubject.next(baseMetrics2);
        });

        it("should return 0 for calculations when values haven't changed", async (): Promise<void> => {
            const baseMetrics = { ...mockBaseMetrics };

            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                expect(metrics.speed).toBe(0);
                expect(metrics.strokeRate).toBe(0);
                expect(metrics.distPerStroke).toBe(0);
            });

            measurementSubject.next(baseMetrics);
            measurementSubject.next(baseMetrics);
        });
    });

    describe("peakForce and peakForcePositionNorm Calculation", (): void => {
        beforeEach((): void => {
            service = TestBed.inject(MetricsService);
        });

        it("should compute peakForce and peakForcePositionNorm for a typical force curve", async (): Promise<void> => {
            const metricsPromise = firstValueFrom(service.rawMetrics$);

            measurementSubject.next(mockBaseMetrics);
            extendedSubject.next(mockExtendedMetrics);
            handleForcesSubject.next([10, 50, 30]);
            measurementSubject.next({
                revTime: mockBaseMetrics.revTime + 1000,
                distance: mockBaseMetrics.distance + 100,
                strokeTime: mockBaseMetrics.strokeTime + 1000,
                strokeCount: mockBaseMetrics.strokeCount + 1,
            });

            const metrics = await metricsPromise;

            expect(metrics.peakForce).toBe(50);
            // peakForceIndex = 1, length = 3 → (1 / 2) * 100 = 50
            expect(metrics.peakForcePositionNorm).toBe(50);
        });

        it("should return peakForcePositionNorm of 0 when peak is at start", async (): Promise<void> => {
            const metricsPromise = firstValueFrom(service.rawMetrics$);

            measurementSubject.next(mockBaseMetrics);
            extendedSubject.next(mockExtendedMetrics);
            handleForcesSubject.next([100, 50, 10]);
            measurementSubject.next({
                revTime: mockBaseMetrics.revTime + 1000,
                distance: mockBaseMetrics.distance + 100,
                strokeTime: mockBaseMetrics.strokeTime + 1000,
                strokeCount: mockBaseMetrics.strokeCount + 1,
            });

            const metrics = await metricsPromise;

            expect(metrics.peakForce).toBe(100);
            // peakForceIndex = 0 → (0 / 2) * 100 = 0
            expect(metrics.peakForcePositionNorm).toBe(0);
        });

        it("should return peakForcePositionNorm of 100 when peak is at end", async (): Promise<void> => {
            const metricsPromise = firstValueFrom(service.rawMetrics$);

            measurementSubject.next(mockBaseMetrics);
            extendedSubject.next(mockExtendedMetrics);
            handleForcesSubject.next([10, 50, 100]);
            measurementSubject.next({
                revTime: mockBaseMetrics.revTime + 1000,
                distance: mockBaseMetrics.distance + 100,
                strokeTime: mockBaseMetrics.strokeTime + 1000,
                strokeCount: mockBaseMetrics.strokeCount + 1,
            });

            const metrics = await metricsPromise;

            expect(metrics.peakForce).toBe(100);
            // peakForceIndex = 2, length = 3 → (2 / 2) * 100 = 100
            expect(metrics.peakForcePositionNorm).toBe(100);
        });

        it("should return 0 for peakForcePositionNorm when handleForces has a single element", async (): Promise<void> => {
            const metricsPromise = firstValueFrom(service.rawMetrics$);

            measurementSubject.next(mockBaseMetrics);
            extendedSubject.next(mockExtendedMetrics);
            handleForcesSubject.next([42]);
            measurementSubject.next({
                revTime: mockBaseMetrics.revTime + 1000,
                distance: mockBaseMetrics.distance + 100,
                strokeTime: mockBaseMetrics.strokeTime + 1000,
                strokeCount: mockBaseMetrics.strokeCount + 1,
            });

            const metrics = await metricsPromise;

            expect(metrics.peakForce).toBe(42);
            // length <= 1 → 0
            expect(metrics.peakForcePositionNorm).toBe(0);
        });

        it("should return 0 for peakForce and peakForcePositionNorm when handleForces is empty", async (): Promise<void> => {
            const metricsPromise = firstValueFrom(service.rawMetrics$);

            measurementSubject.next(mockBaseMetrics);
            extendedSubject.next(mockExtendedMetrics);
            handleForcesSubject.next([]);
            measurementSubject.next({
                revTime: mockBaseMetrics.revTime + 1000,
                distance: mockBaseMetrics.distance + 100,
                strokeTime: mockBaseMetrics.strokeTime + 1000,
                strokeCount: mockBaseMetrics.strokeCount + 1,
            });

            const metrics = await metricsPromise;

            expect(metrics.peakForce).toBe(0);
            expect(metrics.peakForcePositionNorm).toBe(0);
        });

        it("should use the first occurrence when multiple elements are tied for peak", async (): Promise<void> => {
            const metricsPromise = firstValueFrom(service.rawMetrics$);

            measurementSubject.next(mockBaseMetrics);
            extendedSubject.next(mockExtendedMetrics);
            handleForcesSubject.next([50, 50, 50]);
            measurementSubject.next({
                revTime: mockBaseMetrics.revTime + 1000,
                distance: mockBaseMetrics.distance + 100,
                strokeTime: mockBaseMetrics.strokeTime + 1000,
                strokeCount: mockBaseMetrics.strokeCount + 1,
            });

            const metrics = await metricsPromise;

            expect(metrics.peakForce).toBe(50);
            // reduce keeps first max → peakForceIndex = 0 → (0 / 2) * 100 = 0
            expect(metrics.peakForcePositionNorm).toBe(0);
        });
    });

    describe("Data Recording Integration", (): void => {
        beforeEach((): void => {
            service = TestBed.inject(MetricsService);
        });

        it("should add delta times to dataRecorder when ergMetricService.streamDeltaTimes$() emits", (): void => {
            const deltaTimes = [100, 200, 300];
            deltaTimesSubject.next(deltaTimes);

            expect(mockDataRecorderService.addDeltaTimes).toHaveBeenCalledWith(deltaTimes);
        });

        it("should not add empty delta times to dataRecorder", (): void => {
            const emptyDeltaTimes: Array<number> = [];
            deltaTimesSubject.next(emptyDeltaTimes);

            expect(mockDataRecorderService.addDeltaTimes).not.toHaveBeenCalled();
        });

        it("should add connected device to dataRecorder if connectionStatus.deviceName is defined", (): void => {
            connectionStatusSubject.next(mockConnectionStatus);

            expect(mockDataRecorderService.addConnectedDevice).toHaveBeenCalledWith("Test Device");
        });

        it("should not add connected device if connectionStatus.deviceName is undefined", (): void => {
            const connectionStatusWithoutDevice = { ...mockConnectionStatus, deviceName: undefined };

            connectionStatusSubject.next(connectionStatusWithoutDevice);

            expect(mockDataRecorderService.addConnectedDevice).not.toHaveBeenCalled();
        });
    });

    describe("Observable Streams", (): void => {
        beforeEach((): void => {
            service = TestBed.inject(MetricsService);
        });

        it("should emit values from heartRateService.streamHeartRate$() via heartRateData$", async (): Promise<void> => {
            const heartRatePromise = firstValueFrom(service.heartRateData$);
            heartRateSubject.next(mockHeartRate);

            const heartRate = await heartRatePromise;

            expect(heartRate).toEqual(mockHeartRate);
        });

        it("should emit values from heartRateService.connectionStatus$() via hrConnectionStatus$", async (): Promise<void> => {
            const statusPromise = firstValueFrom(service.hrConnectionStatus$);
            hrConnectionStatusSubject.next(mockHRConnectionStatus);

            const status = await statusPromise;

            expect(status).toEqual(mockHRConnectionStatus);
        });
    });

    describe("driveLength Calculation", (): void => {
        beforeEach((): void => {
            service = TestBed.inject(MetricsService);
        });

        it("should calculate driveLength correctly", async (): Promise<void> => {
            mockRowerSettingsSignal.set(
                createMockRowerSettings({
                    sprocketRadius: 150,
                    impulsePerRevolution: 3,
                }),
            );

            const metricsPromise = firstValueFrom(service.rawMetrics$);

            measurementSubject.next(mockBaseMetrics);
            extendedSubject.next(mockExtendedMetrics);
            handleForcesSubject.next([10, 20, 30, 40, 50]);
            measurementSubject.next({
                revTime: mockBaseMetrics.revTime + 1000,
                distance: mockBaseMetrics.distance + 100,
                strokeTime: mockBaseMetrics.strokeTime + 1000,
                strokeCount: mockBaseMetrics.strokeCount + 1,
            });

            const metrics = await metricsPromise;

            // driveLength = ((2 * PI * 150) / 3) * 5 / 100 = (942.4778 / 3) * 5 / 100 = 15.708
            const expected = (((2 * Math.PI * 150) / 3) * 5) / 100;
            expect(metrics.driveLength).toBeCloseTo(expected, 5);
        });

        describe("should return 0 for driveLength ", (): void => {
            it("when impulsePerRevolution is 0", async (): Promise<void> => {
                mockRowerSettingsSignal.set(
                    createMockRowerSettings({
                        sprocketRadius: 150,
                        impulsePerRevolution: 0,
                    }),
                );

                const metricsPromise = firstValueFrom(service.rawMetrics$);

                measurementSubject.next(mockBaseMetrics);
                extendedSubject.next(mockExtendedMetrics);
                handleForcesSubject.next([10, 20, 30]);
                measurementSubject.next({
                    revTime: mockBaseMetrics.revTime + 1000,
                    distance: mockBaseMetrics.distance + 100,
                    strokeTime: mockBaseMetrics.strokeTime + 1000,
                    strokeCount: mockBaseMetrics.strokeCount + 1,
                });

                const metrics = await metricsPromise;

                expect(metrics.driveLength).toBe(0);
            });

            it("when sprocketRadius is 0", async (): Promise<void> => {
                mockRowerSettingsSignal.set(
                    createMockRowerSettings({
                        sprocketRadius: 0,
                        impulsePerRevolution: 3,
                    }),
                );

                const metricsPromise = firstValueFrom(service.rawMetrics$);

                measurementSubject.next(mockBaseMetrics);
                extendedSubject.next(mockExtendedMetrics);
                handleForcesSubject.next([10, 20, 30]);
                measurementSubject.next({
                    revTime: mockBaseMetrics.revTime + 1000,
                    distance: mockBaseMetrics.distance + 100,
                    strokeTime: mockBaseMetrics.strokeTime + 1000,
                    strokeCount: mockBaseMetrics.strokeCount + 1,
                });

                const metrics = await metricsPromise;

                expect(metrics.driveLength).toBe(0);
            });

            it("when handleForces is empty", async (): Promise<void> => {
                mockRowerSettingsSignal.set(
                    createMockRowerSettings({
                        sprocketRadius: 150,
                        impulsePerRevolution: 3,
                    }),
                );

                const metricsPromise = firstValueFrom(service.rawMetrics$);

                measurementSubject.next(mockBaseMetrics);
                extendedSubject.next(mockExtendedMetrics);
                handleForcesSubject.next([]);
                measurementSubject.next({
                    revTime: mockBaseMetrics.revTime + 1000,
                    distance: mockBaseMetrics.distance + 100,
                    strokeTime: mockBaseMetrics.strokeTime + 1000,
                    strokeCount: mockBaseMetrics.strokeCount + 1,
                });

                const metrics = await metricsPromise;

                expect(metrics.driveLength).toBe(0);
            });
        });
    });

    describe("Edge Cases and Error Handling", (): void => {
        beforeEach((): void => {
            service = TestBed.inject(MetricsService);
        });

        it("should handle null or empty string deviceName gracefully", (): void => {
            const baseMetrics = { ...mockBaseMetrics, strokeCount: 1 };
            const connectionWithNullDevice = { status: "connected" as const, deviceName: null };

            service.rawMetrics$.subscribe((): void => {
                expect(mockDataRecorderService.addConnectedDevice).not.toHaveBeenCalled();
            });

            measurementSubject.next(baseMetrics);
            extendedSubject.next(mockExtendedMetrics);
            handleForcesSubject.next([]);
            heartRateSubject.next(mockHeartRate);
            connectionStatusSubject.next(connectionWithNullDevice as unknown as IErgConnectionStatus);
            measurementSubject.next(baseMetrics);
        });

        it("should handle NaN or Infinity values in metrics calculations", async (): Promise<void> => {
            const baseMetrics1: IBaseMetrics = { revTime: 0, distance: 0, strokeTime: 0, strokeCount: 0 };
            const baseMetrics2: IBaseMetrics = { revTime: 0, distance: 1000, strokeTime: 0, strokeCount: 1 };

            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                expect(isNaN(metrics.speed)).toBe(false);
                expect(isFinite(metrics.speed)).toBe(true);
                expect(isNaN(metrics.strokeRate)).toBe(false);
                expect(isFinite(metrics.strokeRate)).toBe(true);
                expect(isNaN(metrics.distPerStroke)).toBe(false);
                expect(isFinite(metrics.distPerStroke)).toBe(true);
            });

            measurementSubject.next(baseMetrics1);
            extendedSubject.next(mockExtendedMetrics);
            handleForcesSubject.next([]);
            measurementSubject.next(baseMetrics2);
        });
    });

    describe("V2 stroke assembly", (): void => {
        it("keeps completed stroke cadence and distance fixed across wheel updates and late recovery", (): void => {
            service = TestBed.inject(MetricsService);
            const rows: Array<IRawCalculatedMetrics> = [];
            const subscription = service.rawMetrics$.subscribe((row: IRawCalculatedMetrics): void => {
                rows.push(row);
            });
            measurementSubject.next({ strokeCount: 1, strokeTime: 3e6, revTime: 3e6, distance: 1000 });
            measurementSubject.next({ strokeCount: 2, strokeTime: 6e6, revTime: 6e6, distance: 1900 });
            measurementSubject.next({ strokeCount: 2, strokeTime: 6e6, revTime: 7e6, distance: 2200 });
            completedStrokeMetricsV2Subject.next({
                strokeId: 2,
                driveDurationUs: 1e6,
                recovery: { status: "complete", durationUs: 2e6, avgStrokePowerW: 100, dragFactor: 100 },
            });
            expect(
                rows
                    .slice(1)
                    .every(
                        (row: IRawCalculatedMetrics): boolean =>
                            row.strokeRate === 20 && row.distPerStroke === 9,
                    ),
            ).toBe(true);
            expect(rows.at(-1)?.recoveryDuration).toBe(2);
            measurementSubject.next({ strokeCount: 3, strokeTime: 9e6, revTime: 9e6, distance: 2800 });
            expect(rows.at(-1)).toMatchObject({ strokeRate: 20, distPerStroke: 9 });
            subscription.unsubscribe();
        });
        beforeEach((): void => {
            service = TestBed.inject(MetricsService);
            physicalForceCurveV2CharacteristicSubject.next({} as BluetoothRemoteGATTCharacteristic);
            completedStrokeMetricsV2CharacteristicSubject.next({} as BluetoothRemoteGATTCharacteristic);
        });

        it("emits base metrics immediately and upserts keyed V2 data without legacy mixing", (): void => {
            const emitted: Array<IRawCalculatedMetrics> = [];
            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                emitted.push(metrics);
            });

            const baseMetrics: IBaseMetrics = {
                revTime: 1_000_000,
                distance: 1_000,
                strokeTime: 2_000_000,
                strokeCount: 7,
            };
            const physicalCurve: IPhysicalForceCurveV2 = {
                strokeId: 7,
                driveLength: 0.5,
                driveDurationUs: 1_000_000,
                samples: [
                    { distance: 0.2, elapsedTimeUs: 250_000, force: 40 },
                    { distance: 0.4, elapsedTimeUs: 800_000, force: 80 },
                ],
            };
            const pendingMetrics: ICompletedStrokeMetricsV2 = {
                strokeId: 7,
                driveDurationUs: 1_000_000,
                recovery: { status: "pending" },
            };
            const completedMetrics: ICompletedStrokeMetricsV2 = {
                strokeId: 7,
                driveDurationUs: 1_000_000,
                recovery: {
                    status: "complete",
                    durationUs: 1_200_000,
                    avgStrokePowerW: 240.5,
                    dragFactor: 122,
                },
            };

            extendedSubject.next({
                avgStrokePower: 999,
                driveDuration: 99,
                recoveryDuration: 99,
                dragFactor: 999,
            });
            handleForcesSubject.next([999, 999]);
            measurementSubject.next(baseMetrics);

            expect(emitted).toHaveLength(1);
            expect(emitted[0]).toMatchObject({
                rawStrokeCount: 7,
                forceCurveStatus: "pending",
                isExtendedMetricsPending: true,
                handleForces: [],
            });

            completedStrokeMetricsV2Subject.next(pendingMetrics);
            physicalForceCurveV2Subject.next(physicalCurve);
            expect(emitted).toHaveLength(3);
            expect(emitted[2]).toMatchObject({
                avgStrokePower: 0,
                driveDuration: 1,
                recoveryDuration: 0,
                dragFactor: 0,
                forceCurveStatus: "complete",
                isExtendedMetricsPending: true,
                forceCurveStrokeId: 7,
                handleForces: [40, 80],
                peakForce: 80,
                peakForcePositionNorm: 80,
                driveLength: 0.5,
            });

            completedStrokeMetricsV2Subject.next(completedMetrics);
            expect(emitted).toHaveLength(4);
            expect(emitted[3]).toMatchObject({
                avgStrokePower: 240.5,
                driveDuration: 1,
                recoveryDuration: 1.2,
                dragFactor: 122,
                isExtendedMetricsPending: false,
                forceCurveStatus: "complete",
            });

            physicalForceCurveV2Subject.next(physicalCurve);
            completedStrokeMetricsV2Subject.next(completedMetrics);
            extendedSubject.next(mockExtendedMetrics);
            handleForcesSubject.next([1]);
            expect(emitted).toHaveLength(4);
        });

        it("keeps V2-only packets pending until a matching fresh base stroke arrives", (): void => {
            const emitted: Array<IRawCalculatedMetrics> = [];
            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                emitted.push(metrics);
            });

            physicalForceCurveV2Subject.next({
                strokeId: 12,
                driveLength: 0.4,
                driveDurationUs: 900_000,
                samples: [{ distance: 0.3, elapsedTimeUs: 700_000, force: 60 }],
            });
            completedStrokeMetricsV2Subject.next({
                strokeId: 12,
                driveDurationUs: 900_000,
                recovery: {
                    status: "complete",
                    durationUs: 1_100_000,
                    avgStrokePowerW: 200,
                    dragFactor: 110,
                },
            });

            expect(emitted).toEqual([]);

            measurementSubject.next({
                revTime: 2_000_000,
                distance: 2_000,
                strokeTime: 3_000_000,
                strokeCount: 12,
            });

            expect(emitted).toHaveLength(1);
            expect(emitted[0]).toMatchObject({
                rawStrokeCount: 12,
                sourceStrokeId: 12,
                forceCurveStatus: "complete",
                isExtendedMetricsPending: false,
                avgStrokePower: 200,
            });
        });

        it("emits late V2 supplements by stroke key without replacing current raw metrics", (): void => {
            const rawMetrics: Array<IRawCalculatedMetrics> = [];
            const strokeUpdates: Array<IRawCalculatedMetrics> = [];
            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                rawMetrics.push(metrics);
            });
            service.strokeMetricUpdates$.subscribe((metrics: IRawCalculatedMetrics): void => {
                strokeUpdates.push(metrics);
            });

            measurementSubject.next({
                revTime: 1_000_000,
                distance: 1_000,
                strokeTime: 2_000_000,
                strokeCount: 20,
            });
            measurementSubject.next({
                revTime: 2_000_000,
                distance: 1_100,
                strokeTime: 3_000_000,
                strokeCount: 21,
            });

            expect(rawMetrics).toHaveLength(2);
            expect(strokeUpdates).toHaveLength(2);

            physicalForceCurveV2Subject.next({
                strokeId: 20,
                driveLength: 0.4,
                driveDurationUs: 900_000,
                samples: [{ distance: 0.3, elapsedTimeUs: 700_000, force: 60 }],
            });
            completedStrokeMetricsV2Subject.next({
                strokeId: 20,
                driveDurationUs: 900_000,
                recovery: {
                    status: "complete",
                    durationUs: 1_100_000,
                    avgStrokePowerW: 200,
                    dragFactor: 110,
                },
            });

            expect(rawMetrics).toHaveLength(2);
            expect(rawMetrics[1]).toMatchObject({ rawStrokeCount: 21, sourceStrokeId: 21 });
            expect(strokeUpdates).toHaveLength(4);
            expect(strokeUpdates[3]).toMatchObject({
                rawStrokeCount: 20,
                sourceStrokeId: 20,
                forceCurveStatus: "complete",
                isExtendedMetricsPending: false,
                avgStrokePower: 200,
            });
        });

        it("uses only the official legacy stream when V2 services are incomplete", (): void => {
            completedStrokeMetricsV2CharacteristicSubject.next(undefined);
            const partialAvailabilityWarning = vi
                .spyOn(console, "warn")
                .mockImplementation((): void => undefined);
            const emitted: Array<IRawCalculatedMetrics> = [];
            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                emitted.push(metrics);
            });

            extendedSubject.next(mockExtendedMetrics);
            handleForcesSubject.next([90, 110]);
            measurementSubject.next({
                revTime: 1_000_000,
                distance: 1_000,
                strokeTime: 2_000_000,
                strokeCount: 8,
            });

            measurementSubject.next({
                revTime: 2_000_000,
                distance: 1_200,
                strokeTime: 3_000_000,
                strokeCount: 9,
            });

            expect(partialAvailabilityWarning).toHaveBeenCalledOnce();
            expect(emitted).toHaveLength(1);
            expect(emitted[0]).toMatchObject({
                handleForces: [90, 110],
                avgStrokePower: 100,
                recoveryDuration: 2,
                dragFactor: 120,
            });

            partialAvailabilityWarning.mockRestore();
        });
    });

    describe("powerBalance computation", (): void => {
        beforeEach((): void => {
            service = TestBed.inject(MetricsService);
        });

        it("should default powerBalance to 0.5 before any valid side pair is formed", (): void => {
            const emitted: Array<IRawCalculatedMetrics> = [];
            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                emitted.push(metrics);
            });

            // seed the pairwise and emit a side-A stroke (odd strokeCount)
            measurementSubject.next({ revTime: 0, distance: 0, strokeTime: 0, strokeCount: 0 });
            handleForcesSubject.next([100]);
            measurementSubject.next({ revTime: 1000, distance: 100, strokeTime: 1000, strokeCount: 1 });

            expect(emitted).toHaveLength(1);
            expect(emitted[0].powerBalance).toBe(0.5);
        });

        it("should emit rawMetrics$ exactly once per stroke", (): void => {
            let emissionCount = 0;
            service.rawMetrics$.subscribe((): void => {
                emissionCount++;
            });

            measurementSubject.next({ revTime: 0, distance: 0, strokeTime: 0, strokeCount: 0 });
            handleForcesSubject.next([100]);
            measurementSubject.next({ revTime: 1000, distance: 100, strokeTime: 1000, strokeCount: 1 });

            expect(emissionCount).toBe(1);
        });

        it("should compute powerBalance when consecutive odd+even strokes pair up", (): void => {
            const emitted: Array<IRawCalculatedMetrics> = [];
            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                emitted.push(metrics);
            });

            // side A: stronger (120 N mean force)
            handleForcesSubject.next([120, 120]);
            measurementSubject.next({ revTime: 0, distance: 0, strokeTime: 0, strokeCount: 0 });
            measurementSubject.next({ revTime: 1000, distance: 100, strokeTime: 1000, strokeCount: 1 });

            // side B: weaker (80 N mean force)
            handleForcesSubject.next([80, 80]);
            measurementSubject.next({ revTime: 2000, distance: 200, strokeTime: 2000, strokeCount: 2 });

            // first emission (stroke 1) still has the default balance.
            expect(emitted[0].powerBalance).toBe(0.5);
            const lastEmitted: IRawCalculatedMetrics = emitted[emitted.length - 1];
            expect(lastEmitted.powerBalance).toBeCloseTo(120 / (120 + 80));
        });

        it("should retain the previous balance when force updates arrive mid-stroke (same strokeCount)", (): void => {
            const emitted: Array<IRawCalculatedMetrics> = [];
            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                emitted.push(metrics);
            });

            handleForcesSubject.next([120, 120]); // side A forces
            measurementSubject.next({ revTime: 0, distance: 0, strokeTime: 0, strokeCount: 0 });
            measurementSubject.next({ revTime: 1000, distance: 100, strokeTime: 1000, strokeCount: 1 });

            handleForcesSubject.next([999, 999]);

            handleForcesSubject.next([80, 80]); // side B forces
            measurementSubject.next({ revTime: 2000, distance: 200, strokeTime: 2000, strokeCount: 2 });

            const lastEmitted: IRawCalculatedMetrics = emitted[emitted.length - 1];
            expect(lastEmitted.powerBalance).toBeCloseTo(120 / (120 + 80));
        });

        it("should retain the last balance when an even stroke is not consecutive with the preceding odd stroke", (): void => {
            const emitted: Array<IRawCalculatedMetrics> = [];
            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                emitted.push(metrics);
            });

            // set forces once before pairwise fires — no updates between strokes
            handleForcesSubject.next([100]);

            // stroke 1 (odd, side A)
            measurementSubject.next({ revTime: 0, distance: 0, strokeTime: 0, strokeCount: 0 });
            measurementSubject.next({ revTime: 1000, distance: 100, strokeTime: 1000, strokeCount: 1 });

            // strokeCount = 4 (even, not consecutive with 1) — no force update between strokes
            measurementSubject.next({ revTime: 2000, distance: 200, strokeTime: 2000, strokeCount: 4 });

            expect(emitted).toHaveLength(2);
            expect(emitted[0].powerBalance).toBe(0.5);
            expect(emitted[1].powerBalance).toBe(0.5);
        });

        it("should return 0.5 balance when both sides have zero force", (): void => {
            const emitted: Array<IRawCalculatedMetrics> = [];
            service.rawMetrics$.subscribe((metrics: IRawCalculatedMetrics): void => {
                emitted.push(metrics);
            });

            measurementSubject.next({ revTime: 0, distance: 0, strokeTime: 0, strokeCount: 0 });
            handleForcesSubject.next([0]);
            measurementSubject.next({ revTime: 1000, distance: 100, strokeTime: 1000, strokeCount: 1 });

            handleForcesSubject.next([0]);
            measurementSubject.next({ revTime: 2000, distance: 200, strokeTime: 2000, strokeCount: 2 });

            expect(emitted[1].powerBalance).toBe(0.5);
        });
    });
});
