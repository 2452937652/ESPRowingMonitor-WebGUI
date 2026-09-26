import { DestroyRef, Injectable } from "@angular/core";
import { takeUntilDestroyed, toObservable } from "@angular/core/rxjs-interop";
import {
    BehaviorSubject,
    combineLatest,
    defer,
    distinctUntilChanged,
    EMPTY,
    filter,
    map,
    Observable,
    of,
    pairwise,
    shareReplay,
    startWith,
    Subject,
    switchMap,
    take,
    withLatestFrom,
} from "rxjs";

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
import { IPhysicalForceCurveV2 } from "./ergometer/physical-force-curve-v2-decoder";
import { HeartRateService } from "./heart-rate/heart-rate.service";
import { StrokeBaseObservation, StrokeBaseTracker } from "./stroke-base-tracker";
import { IAssembledStrokeMetrics, StrokeMetricsAssembler } from "./stroke-metrics-assembler";

const cmInM = 100;

type LegacyMetricInput = [
    [StrokeBaseObservation, StrokeBaseObservation],
    IExtendedMetrics,
    Array<number>,
    IRowerSettings,
];

type MetricSourceMode = "offline" | "legacy" | "v2";

@Injectable({
    providedIn: "root",
})
export class MetricsService {
    readonly rawMetrics$: Observable<IRawCalculatedMetrics>;
    readonly strokeMetricUpdates$: Observable<IRawCalculatedMetrics>;
    readonly heartRateData$: Observable<IHeartRate | undefined>;
    readonly hrConnectionStatus$: Observable<IHRConnectionStatus>;

    private readonly measurement$: Observable<IBaseMetrics> = this.ergMetricService
        .streamMeasurement$()
        .pipe(shareReplay({ bufferSize: 1, refCount: true }));

    private readonly handleForces$: Observable<Array<number>> = this.ergMetricService
        .streamHandleForces$()
        .pipe(startWith([] as Array<number>), shareReplay({ bufferSize: 1, refCount: true }));
    private readonly sourceMode$: Observable<MetricSourceMode> = this.streamSourceMode$();
    private readonly strokeMetricsAssembler: StrokeMetricsAssembler = new StrokeMetricsAssembler();
    private readonly assembledStrokeSubject: BehaviorSubject<IAssembledStrokeMetrics | undefined> =
        new BehaviorSubject<IAssembledStrokeMetrics | undefined>(undefined);
    private readonly strokeMetricUpdateSubject: Subject<IAssembledStrokeMetrics> =
        new Subject<IAssembledStrokeMetrics>();
    private readonly settingsChanges$: Observable<IRowerSettings> = toObservable(
        this.ergSettingsService.rowerSettings,
    );
    private currentBaseStrokeId: number | undefined;

    constructor(
        private ergMetricService: ErgMetricsService,
        private ergConnectionService: ErgConnectionService,
        private ergSettingsService: ErgSettingsService,
        private dataRecorder: DataRecorderService,
        private heartRateService: HeartRateService,
        private destroyRef: DestroyRef,
    ) {
        this.rawMetrics$ = this.streamMetrics$().pipe(shareReplay({ bufferSize: 1, refCount: true }));
        this.strokeMetricUpdates$ = this.strokeMetricUpdateSubject.pipe(
            map((assembly: IAssembledStrokeMetrics): IRawCalculatedMetrics =>
                this.buildV2RawMetrics(assembly),
            ),
        );
        this.heartRateData$ = this.heartRateService.streamHeartRate$();
        this.hrConnectionStatus$ = this.heartRateService.connectionStatus$();

        this.setupLogging();
        this.setupStrokeMetricsAssembler();

        if (isSecureContext === true && navigator.bluetooth !== undefined) {
            this.ergConnectionService.reconnect();
        }
    }

    private calculateDriveLength(handleForcesLength: number): number {
        const {
            sprocketRadius,
            impulsePerRevolution,
        }: { sprocketRadius: number; impulsePerRevolution: number } =
            this.ergSettingsService.rowerSettings().rowingSettings.machineSettings;

        if (impulsePerRevolution === 0 || sprocketRadius === 0 || handleForcesLength === 0) {
            return 0;
        }

        return (((2 * Math.PI * sprocketRadius) / impulsePerRevolution) * handleForcesLength) / cmInM;
    }

    private calculateSpeed(baseMetricsPrevious: IBaseMetrics, baseMetricsCurrent: IBaseMetrics): number {
        if (
            baseMetricsCurrent.distance === baseMetricsPrevious.distance ||
            baseMetricsCurrent.revTime === baseMetricsPrevious.revTime
        ) {
            return 0;
        }

        return (
            (baseMetricsCurrent.distance - baseMetricsPrevious.distance) /
            cmInM /
            ((baseMetricsCurrent.revTime - baseMetricsPrevious.revTime) / 1e6)
        );
    }
    private calculateStrokeDistance(
        baseMetricsPrevious: IBaseMetrics,
        baseMetricsCurrent: IBaseMetrics,
    ): number {
        const strokeCountDelta: number = this.strokeCountDelta(baseMetricsPrevious, baseMetricsCurrent);
        if (baseMetricsCurrent.distance === baseMetricsPrevious.distance || strokeCountDelta === 0) {
            return 0;
        }

        return (baseMetricsCurrent.distance - baseMetricsPrevious.distance) / cmInM / strokeCountDelta;
    }

    private calculateStrokeRate(baseMetricsPrevious: IBaseMetrics, baseMetricsCurrent: IBaseMetrics): number {
        const strokeCountDelta: number = this.strokeCountDelta(baseMetricsPrevious, baseMetricsCurrent);
        if (strokeCountDelta === 0 || baseMetricsCurrent.strokeTime === baseMetricsPrevious.strokeTime) {
            return 0;
        }

        return (
            (strokeCountDelta / ((baseMetricsCurrent.strokeTime - baseMetricsPrevious.strokeTime) / 1e6)) * 60
        );
    }

    private strokeCountDelta(baseMetricsPrevious: IBaseMetrics, baseMetricsCurrent: IBaseMetrics): number {
        return (baseMetricsCurrent.strokeCount - baseMetricsPrevious.strokeCount + 0x10000) % 0x10000;
    }

    private setupLogging(): void {
        this.ergMetricService
            .streamDeltaTimes$()
            .pipe(
                filter((deltaTimes: Array<number>): boolean => deltaTimes.length > 0),
                takeUntilDestroyed(this.destroyRef),
            )
            .subscribe((deltaTimes: Array<number>): void => {
                this.dataRecorder.addDeltaTimes(deltaTimes);
            });

        this.ergConnectionService
            .connectionStatus$()
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((connectionStatus: IErgConnectionStatus): void => {
                if (connectionStatus.deviceName && connectionStatus.deviceName.length > 0) {
                    this.dataRecorder.addConnectedDevice(connectionStatus.deviceName);
                }
            });
    }

    private streamMetrics$(): Observable<IRawCalculatedMetrics> {
        return this.sourceMode$.pipe(
            switchMap((mode: MetricSourceMode): Observable<IRawCalculatedMetrics> => {
                if (mode === "legacy") {
                    return this.streamLegacyMetrics$();
                }
                if (mode === "v2") {
                    return this.streamV2Metrics$();
                }

                return EMPTY;
            }),
        );
    }

    private streamLegacyMetrics$(): Observable<IRawCalculatedMetrics> {
        return combineLatest([
            defer((): Observable<[StrokeBaseObservation, StrokeBaseObservation]> => {
                const tracker = new StrokeBaseTracker();

                return this.measurement$.pipe(
                    map((base: IBaseMetrics): StrokeBaseObservation => ({
                        base,
                        stroke: tracker.accept(base),
                    })),
                    pairwise(),
                );
            }),
            this.streamExtended$(),
            this.handleForces$,
            this.settingsChanges$.pipe(startWith(this.ergSettingsService.rowerSettings())),
        ]).pipe(
            withLatestFrom(this.streamPowerBalance$()),
            map(([metricsInput, powerBalance]: [LegacyMetricInput, number]): IRawCalculatedMetrics => {
                const [[previous, current], extendedMetrics, handleForces]: LegacyMetricInput = metricsInput;
                const baseMetricsPrevious = previous.base;
                const baseMetricsCurrent = current.base;
                const { peakForce, peakForceIndex }: { peakForce: number; peakForceIndex: number } =
                    handleForces.reduce(
                        (
                            accumulator: { peakForce: number; peakForceIndex: number },
                            force: number,
                            index: number,
                        ): { peakForce: number; peakForceIndex: number } =>
                            force > accumulator.peakForce
                                ? { peakForce: force, peakForceIndex: index }
                                : accumulator,
                        { peakForce: 0, peakForceIndex: 0 },
                    );

                return {
                    avgStrokePower: extendedMetrics.avgStrokePower,
                    driveDuration: extendedMetrics.driveDuration / 1e6,
                    recoveryDuration: extendedMetrics.recoveryDuration / 1e6,
                    dragFactor: extendedMetrics.dragFactor,
                    rawDistance: baseMetricsCurrent.distance,
                    rawStrokeCount: baseMetricsCurrent.strokeCount,
                    handleForces,
                    peakForce,
                    peakForcePositionNorm:
                        handleForces.length > 1 ? (peakForceIndex / (handleForces.length - 1)) * 100 : 0,
                    strokeRate: current.stroke.strokeRate,
                    speed: this.calculateSpeed(baseMetricsPrevious, baseMetricsCurrent),
                    distPerStroke: current.stroke.distPerStroke,
                    driveLength: this.calculateDriveLength(handleForces.length),
                    powerBalance,
                };
            }),
        );
    }

    private streamV2Metrics$(): Observable<IRawCalculatedMetrics> {
        return this.assembledStrokeSubject.pipe(
            filter(
                (assembly: IAssembledStrokeMetrics | undefined): assembly is IAssembledStrokeMetrics =>
                    assembly !== undefined,
            ),
            map((assembly: IAssembledStrokeMetrics): IRawCalculatedMetrics =>
                this.buildV2RawMetrics(assembly),
            ),
        );
    }

    private streamSourceMode$(): Observable<MetricSourceMode> {
        return this.ergConnectionService.connectionStatus$().pipe(
            switchMap((connectionStatus: IErgConnectionStatus): Observable<MetricSourceMode> => {
                if (connectionStatus.status !== "connected") {
                    return of("offline");
                }

                return combineLatest([
                    this.ergConnectionService.physicalForceCurveV2Characteristic$,
                    this.ergConnectionService.completedStrokeMetricsV2Characteristic$,
                ]).pipe(
                    take(1),
                    map(
                        ([physicalCurve, completedMetrics]: [
                            BluetoothRemoteGATTCharacteristic | undefined,
                            BluetoothRemoteGATTCharacteristic | undefined,
                        ]): MetricSourceMode => {
                            if (physicalCurve !== undefined && completedMetrics !== undefined) {
                                return "v2";
                            }

                            if (physicalCurve !== undefined || completedMetrics !== undefined) {
                                console.warn(
                                    "Incomplete V2 services; using the complete official legacy metric stream",
                                );
                            }

                            return "legacy";
                        },
                    ),
                );
            }),
            distinctUntilChanged(),
            shareReplay({ bufferSize: 1, refCount: true }),
        );
    }

    private setupStrokeMetricsAssembler(): void {
        this.ergConnectionService
            .connectionStatus$()
            .pipe(
                filter(
                    (connectionStatus: IErgConnectionStatus): boolean =>
                        connectionStatus.status === "disconnected" ||
                        connectionStatus.status === "connecting",
                ),
                takeUntilDestroyed(this.destroyRef),
            )
            .subscribe((): void => {
                this.strokeMetricsAssembler.resetSourceEpoch();
                this.currentBaseStrokeId = undefined;
                this.assembledStrokeSubject.next(undefined);
            });

        this.measurement$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((baseMetrics: IBaseMetrics): void => {
                const update = this.strokeMetricsAssembler.acceptBaseMetrics(baseMetrics);
                if (update.accepted && update.assembly !== undefined) {
                    this.currentBaseStrokeId = update.sourceStrokeId;
                    this.assembledStrokeSubject.next(update.assembly);
                    this.strokeMetricUpdateSubject.next(update.assembly);
                }
            });

        this.ergMetricService
            .streamPhysicalForceCurveV2$()
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((curve: IPhysicalForceCurveV2): void => {
                const update = this.strokeMetricsAssembler.acceptPhysicalCurve(curve);
                if (update.accepted && update.assembly !== undefined) {
                    this.strokeMetricUpdateSubject.next(update.assembly);
                }
                if (update.accepted && update.sourceStrokeId === this.currentBaseStrokeId) {
                    this.assembledStrokeSubject.next(update.assembly);
                }
            });

        this.ergMetricService
            .streamCompletedStrokeMetricsV2$()
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((metrics: ICompletedStrokeMetricsV2): void => {
                const update = this.strokeMetricsAssembler.acceptCompletedMetrics(metrics);
                if (update.accepted && update.assembly !== undefined) {
                    this.strokeMetricUpdateSubject.next(update.assembly);
                }
                if (update.accepted && update.sourceStrokeId === this.currentBaseStrokeId) {
                    this.assembledStrokeSubject.next(update.assembly);
                }
            });
    }

    private buildV2RawMetrics(assembly: IAssembledStrokeMetrics): IRawCalculatedMetrics {
        const { base, completedMetrics, physicalCurve, previousBase }: IAssembledStrokeMetrics = assembly;
        const forceFields = this.buildV2ForceFields(physicalCurve);
        const extendedFields = this.buildV2ExtendedFields(completedMetrics, physicalCurve);

        return {
            sourceEpoch: assembly.sourceEpoch,
            sourceStrokeId: assembly.sourceStrokeId,
            ...forceFields,
            ...extendedFields,
            rawDistance: base.distance,
            rawStrokeCount: base.strokeCount,
            strokeRate: this.calculateStrokeRate(assembly.previousStrokeBase ?? previousBase, base),
            speed: this.calculateSpeed(previousBase, base),
            distPerStroke: this.calculateStrokeDistance(assembly.previousStrokeBase ?? previousBase, base),
            powerBalance: 0.5,
        };
    }

    private buildV2ForceFields(
        physicalCurve: IPhysicalForceCurveV2 | undefined,
    ): Pick<
        IRawCalculatedMetrics,
        | "forceCurve"
        | "forceCurveStatus"
        | "forceCurveStrokeId"
        | "handleForces"
        | "peakForce"
        | "peakForcePositionNorm"
        | "driveLength"
    > {
        const handleForces: Array<number> =
            physicalCurve?.samples.map(
                (sample: IPhysicalForceCurveV2["samples"][number]): number => sample.force,
            ) ?? [];
        const peak: { peakForce: number; peakForceIndex: number } = handleForces.reduce(
            (
                accumulator: { peakForce: number; peakForceIndex: number },
                force: number,
                index: number,
            ): { peakForce: number; peakForceIndex: number } =>
                force > accumulator.peakForce ? { peakForce: force, peakForceIndex: index } : accumulator,
            { peakForce: 0, peakForceIndex: 0 },
        );

        return {
            forceCurve:
                physicalCurve === undefined
                    ? undefined
                    : {
                          strokeId: physicalCurve.strokeId,
                          driveLength: physicalCurve.driveLength,
                          driveDurationUs: physicalCurve.driveDurationUs,
                          samples: physicalCurve.samples,
                      },
            forceCurveStatus: physicalCurve === undefined ? "pending" : "complete",
            forceCurveStrokeId: physicalCurve?.strokeId,
            handleForces,
            peakForce: peak.peakForce,
            peakForcePositionNorm:
                physicalCurve !== undefined && physicalCurve.driveLength > 0
                    ? ((physicalCurve.samples[peak.peakForceIndex]?.distance ?? 0) /
                          physicalCurve.driveLength) *
                      100
                    : 0,
            driveLength: physicalCurve?.driveLength ?? 0,
        };
    }

    private buildV2ExtendedFields(
        completedMetrics: ICompletedStrokeMetricsV2 | undefined,
        physicalCurve: IPhysicalForceCurveV2 | undefined,
    ): Pick<
        IRawCalculatedMetrics,
        "isExtendedMetricsPending" | "avgStrokePower" | "driveDuration" | "recoveryDuration" | "dragFactor"
    > {
        const recovery =
            completedMetrics?.recovery.status === "complete" ? completedMetrics.recovery : undefined;

        return {
            isExtendedMetricsPending: recovery === undefined,
            avgStrokePower: recovery?.avgStrokePowerW ?? 0,
            driveDuration: (physicalCurve?.driveDurationUs ?? completedMetrics?.driveDurationUs ?? 0) / 1e6,
            recoveryDuration: recovery === undefined ? 0 : recovery.durationUs / 1e6,
            dragFactor: recovery?.dragFactor ?? 0,
        };
    }

    /**
     * Produces a rolling kayak power-balance value (side-A fraction, 0–1).
     *
     * Uses `combineLatest` to ensure handle forces are always paired with their
     * matching measurement, then deduplicates by strokeCount so only the last
     * emission per stroke is kept. `pairwise()` surfaces consecutive [prev, curr]
     * stroke pairs; only valid A+B pairs (odd stroke followed immediately by the
     * next even stroke) pass the filter and feed the balance computation.
     * Emits a new balance only when a complete pair is detected; between pairs the
     * `withLatestFrom` in `streamBasicMetrics$` retains the last emitted value.
     * Starts at 0.5 (perfectly balanced) before the first complete pair arrives.
     */
    private streamPowerBalance$(): Observable<number> {
        return combineLatest([this.measurement$, this.handleForces$]).pipe(
            distinctUntilChanged(
                (
                    [previousMeasurement]: [IBaseMetrics, Array<number>],
                    [currentMeasurement]: [IBaseMetrics, Array<number>],
                ): boolean => previousMeasurement.strokeCount === currentMeasurement.strokeCount,
            ),
            pairwise(),
            filter(
                ([[previousMeasurement], [currentMeasurement]]: [
                    [IBaseMetrics, Array<number>],
                    [IBaseMetrics, Array<number>],
                ]): boolean =>
                    previousMeasurement.strokeCount % 2 === 1 &&
                    currentMeasurement.strokeCount === previousMeasurement.strokeCount + 1,
            ),
            map(
                ([[, sideAForces], [, sideBForces]]: [
                    [IBaseMetrics, Array<number>],
                    [IBaseMetrics, Array<number>],
                ]): number => {
                    const meanA: number =
                        sideAForces.length > 0
                            ? sideAForces.reduce((sum: number, force: number): number => sum + force, 0) /
                              sideAForces.length
                            : 0;
                    const meanB: number =
                        sideBForces.length > 0
                            ? sideBForces.reduce((sum: number, force: number): number => sum + force, 0) /
                              sideBForces.length
                            : 0;
                    const totalForce: number = meanA + meanB;

                    return totalForce > 0 ? meanA / totalForce : 0.5;
                },
            ),
            startWith(0.5),
        );
    }

    private streamExtended$(): Observable<IExtendedMetrics> {
        return this.ergMetricService.streamExtended$().pipe(
            startWith({
                avgStrokePower: 0,
                dragFactor: 0,
                driveDuration: 0,
                recoveryDuration: 0,
            }),
        );
    }
}
