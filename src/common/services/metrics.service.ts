import { DestroyRef, Injectable } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import {
    defer,
    distinctUntilChanged,
    filter,
    map,
    merge,
    Observable,
    of,
    pairwise,
    scan,
    shareReplay,
    startWith,
} from "rxjs";

import {
    IBaseMetrics,
    IErgConnectionStatus,
    IExtendedMetrics,
    IForceCurve,
    IHeartRate,
    IHRConnectionStatus,
    IRawCalculatedMetrics,
} from "../common.interfaces";

import { DataRecorderService } from "./data-recorder.service";
import { ErgConnectionService } from "./ergometer/erg-connection.service";
import { ErgMetricsService } from "./ergometer/erg-metric-data.service";
import { ErgSettingsService } from "./ergometer/erg-settings.service";
import { HeartRateService } from "./heart-rate/heart-rate.service";
import {
    IStrokeMetricUpdate,
    StrokeMetricsAssembler,
} from "./stroke-metrics-assembler";

const cmInM = 100;

type StrokeMetricInput =
    | { type: "base"; value: IBaseMetrics }
    | { type: "extended"; value: IExtendedMetrics }
    | { type: "legacyForces"; value: Array<number> }
    | { type: "physicalCurve"; value: IForceCurve }
    | { type: "physicalCurveSupport"; value: boolean }
    | { type: "reset" };

interface AssemblyState {
    assembler: StrokeMetricsAssembler;
    update: IStrokeMetricUpdate | undefined;
}

interface PowerBalanceState {
    balance: number;
    completedForces: Map<string, Array<number>>;
    update?: IStrokeMetricUpdate;
}

@Injectable({
    providedIn: "root",
})
export class MetricsService {
    readonly rawMetrics$: Observable<IRawCalculatedMetrics>;
    readonly strokeMetricUpdates$: Observable<IStrokeMetricUpdate>;
    readonly heartRateData$: Observable<IHeartRate | undefined>;
    readonly hrConnectionStatus$: Observable<IHRConnectionStatus>;

    private readonly measurement$: Observable<IBaseMetrics> = this.ergMetricService
        .streamMeasurement$()
        .pipe(shareReplay({ bufferSize: 1, refCount: true }));

    private readonly handleForces$: Observable<Array<number>> = this.ergMetricService
        .streamHandleForces$()
        .pipe(startWith([] as Array<number>), shareReplay({ bufferSize: 1, refCount: true }));

    private readonly forceCurve$: Observable<IForceCurve> = ((): Observable<IForceCurve> => {
        const streamHandleForceCurve = this.ergMetricService.streamHandleForceCurve$;
        if (typeof streamHandleForceCurve !== "function") {
            return of();
        }

        return streamHandleForceCurve.call(this.ergMetricService);
    })().pipe(shareReplay({ bufferSize: 1, refCount: true }));

    private readonly forceCurveSupported$: Observable<boolean> = ((): Observable<boolean> => {
        const streamForceCurveSupport = this.ergMetricService.streamHandleForceCurveSupport$;
        if (typeof streamForceCurveSupport !== "function") {
            return of(false);
        }

        return streamForceCurveSupport.call(this.ergMetricService).pipe(startWith(false));
    })().pipe(distinctUntilChanged(), shareReplay({ bufferSize: 1, refCount: true }));

    constructor(
        private ergMetricService: ErgMetricsService,
        private ergConnectionService: ErgConnectionService,
        private ergSettingsService: ErgSettingsService,
        private dataRecorder: DataRecorderService,
        private heartRateService: HeartRateService,
        private destroyRef: DestroyRef,
    ) {
        this.strokeMetricUpdates$ = this.streamStrokeMetricUpdates$().pipe(
            shareReplay({ bufferSize: 1, refCount: true }),
        );
        this.rawMetrics$ = this.strokeMetricUpdates$.pipe(
            filter((update: IStrokeMetricUpdate): boolean => update.isCurrentStroke),
            map((update: IStrokeMetricUpdate): IRawCalculatedMetrics => update.metrics),
            shareReplay({ bufferSize: 1, refCount: true }),
        );
        this.heartRateData$ = this.heartRateService.streamHeartRate$();
        this.hrConnectionStatus$ = this.heartRateService.connectionStatus$();

        this.setupLogging();

        if (isSecureContext === true && navigator.bluetooth !== undefined) {
            this.ergConnectionService.reconnect();
        }
    }

    private calculateLegacyDriveLength(handleForcesLength: number): number {
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

    private streamStrokeMetricUpdates$(): Observable<IStrokeMetricUpdate> {
        return defer((): Observable<IStrokeMetricUpdate> => {
            const inputs$: Observable<StrokeMetricInput> = merge(
                this.measurement$.pipe(
                    map((value: IBaseMetrics): StrokeMetricInput => ({ type: "base", value })),
                ),
                this.ergMetricService.streamExtended$().pipe(
                    map((value: IExtendedMetrics): StrokeMetricInput => ({ type: "extended", value })),
                ),
                this.handleForces$.pipe(
                    map((value: Array<number>): StrokeMetricInput => ({ type: "legacyForces", value })),
                ),
                this.forceCurve$.pipe(
                    map((value: IForceCurve): StrokeMetricInput => ({ type: "physicalCurve", value })),
                ),
                this.forceCurveSupported$.pipe(
                    map((value: boolean): StrokeMetricInput => ({ type: "physicalCurveSupport", value })),
                ),
                this.ergConnectionService.connectionStatus$().pipe(
                    pairwise(),
                    filter(
                        ([previous, current]: [IErgConnectionStatus, IErgConnectionStatus]): boolean =>
                            previous.status !== "disconnected" && current.status === "disconnected",
                    ),
                    map((): StrokeMetricInput => ({ type: "reset" })),
                ),
            );

            return inputs$.pipe(
                scan(
                    (state: AssemblyState, input: StrokeMetricInput): AssemblyState => {
                        switch (input.type) {
                            case "base":
                                return {
                                    ...state,
                                    update: state.assembler.acceptBaseMetrics(input.value),
                                };
                            case "extended":
                                return {
                                    ...state,
                                    update: state.assembler.acceptExtendedMetrics(input.value, input.value.strokeId),
                                };
                            case "legacyForces":
                                return {
                                    ...state,
                                    update: state.assembler.acceptLegacyForces(input.value),
                                };
                            case "physicalCurve":
                                return {
                                    ...state,
                                    update: state.assembler.acceptPhysicalCurve(input.value),
                                };
                            case "physicalCurveSupport":
                                return {
                                    ...state,
                                    update: state.assembler.acceptPhysicalCurveSupport(input.value),
                                };
                            case "reset":
                                state.assembler.reset();

                                return { ...state, update: undefined };
                        }
                    },
                    {
                        assembler: new StrokeMetricsAssembler((sampleCount: number): number =>
                            this.calculateLegacyDriveLength(sampleCount),
                        ),
                        update: undefined,
                    },
                ),
                map((state: AssemblyState): IStrokeMetricUpdate | undefined => state.update),
                filter(
                    (update: IStrokeMetricUpdate | undefined): update is IStrokeMetricUpdate => update !== undefined,
                ),
                scan(
                    (
                        state: PowerBalanceState,
                        update: IStrokeMetricUpdate,
                    ): PowerBalanceState => {
                        const sourceKey = `${update.sourceEpoch}:${update.sourceStrokeId}`;
                        const completedForces = new Map(state.completedForces);
                        const isCompletedCurve =
                            update.metrics.forceCurveStatus === "complete" ||
                            update.metrics.forceCurveStatus === "legacy";
                        if (isCompletedCurve && update.metrics.handleForces.length > 0) {
                            completedForces.set(sourceKey, update.metrics.handleForces);
                        }

                        let balance = state.balance;
                        const priorKey = `${update.sourceEpoch}:${update.sourceStrokeId - 1}`;
                        const priorForces = completedForces.get(priorKey);
                        const currentForces = completedForces.get(sourceKey);
                        if (update.sourceStrokeId % 2 === 0 && priorForces !== undefined && currentForces !== undefined) {
                            const mean = (forces: Array<number>): number =>
                                forces.reduce((sum: number, force: number): number => sum + force, 0) /
                                forces.length;
                            const meanA = mean(priorForces);
                            const meanB = mean(currentForces);
                            balance = meanA + meanB > 0 ? meanA / (meanA + meanB) : 0.5;
                        }

                        return {
                            balance,
                            completedForces,
                            update: {
                                ...update,
                                metrics: { ...update.metrics, powerBalance: balance },
                            },
                        };
                    },
                    { balance: 0.5, completedForces: new Map<string, Array<number>>() },
                ),
                map((state: PowerBalanceState): IStrokeMetricUpdate => state.update!),
            );
        });
    }
}
