import { Injectable, Signal, signal, WritableSignal } from "@angular/core";
import { takeUntilDestroyed, toSignal } from "@angular/core/rxjs-interop";
import { MatSnackBar } from "@angular/material/snack-bar";
import {
    BehaviorSubject,
    combineLatest,
    distinctUntilChanged,
    EMPTY,
    filter,
    interval,
    map,
    merge,
    Observable,
    of,
    pairwise,
    scan,
    shareReplay,
    startWith,
    Subject,
    switchMap,
    takeUntil,
    withLatestFrom,
} from "rxjs";

import {
    AutoLapMode,
    Config,
    ICalculatedMetrics,
    IDisplayForceCurve,
    IErgConnectionStatus,
    IHeartRate,
    IIntervalsIcuConfig,
    IRawCalculatedMetrics,
    ISessionData,
    SessionState,
} from "../common.interfaces";
import { Stopwatch } from "../utils/stopwatch";

import { ConfigManagerService } from "./config-manager.service";
import { DataRecorderService } from "./data-recorder.service";
import { ErgConnectionService } from "./ergometer/erg-connection.service";
import { IntervalsIcuService } from "./intervals-icu.service";
import { MetricsService } from "./metrics.service";
import { IStrokeMetricUpdate } from "./stroke-metrics-assembler";

const ZERO_RAW_METRICS: IRawCalculatedMetrics = {
    avgStrokePower: 0,
    driveDuration: 0,
    recoveryDuration: 0,
    dragFactor: 0,
    rawDistance: 0,
    rawStrokeCount: 0,
    handleForces: [],
    peakForce: 0,
    peakForcePositionNorm: 0,
    strokeRate: 0,
    speed: 0,
    distPerStroke: 0,
    driveLength: 0,
    powerBalance: 0.5,
};

interface SessionAccumulator {
    sessionMetrics: ICalculatedMetrics;
    previousRawMetrics: IRawCalculatedMetrics;
    previousSourceEpoch: number;
    activeSourceKey: string | undefined;
    sourceRecords: Map<string, SessionStrokeRecord>;
    displayForceCurve: IDisplayForceCurve | undefined;
    update: SessionUpdate | undefined;
}

interface SessionStrokeRecord {
    distance: number;
    strokeCount: number;
    work: number;
    rawDistance: number;
    metrics: ICalculatedMetrics;
}

interface SessionUpdate {
    metrics: ICalculatedMetrics;
    record?: ICalculatedMetrics;
}

interface FallbackMetricState {
    epoch: number;
    previous?: IRawCalculatedMetrics;
}

@Injectable({
    providedIn: "root",
})
export class SessionManagerService {
    readonly sessionState: Signal<SessionState>;
    readonly elapsedTime: Signal<number>;
    readonly sessionMetrics$: Observable<ICalculatedMetrics>;
    private readonly sessionUpdates$: Observable<SessionUpdate>;

    private sessionState$: BehaviorSubject<SessionState> = new BehaviorSubject<SessionState>("stopped");
    private _elapsedTime: WritableSignal<number> = signal<number>(0);
    private readonly lapCount: WritableSignal<number> = signal<number>(0);
    private readonly currentStrokeCount: Signal<number>;

    private readonly autoStartSeed$: Subject<IRawCalculatedMetrics> = new Subject<IRawCalculatedMetrics>();
    private readonly sessionSeed: Observable<IRawCalculatedMetrics> = merge(
        this.metricsService.rawMetrics$,
        this.autoStartSeed$,
    ).pipe(startWith(ZERO_RAW_METRICS), shareReplay({ bufferSize: 1, refCount: true }));

    private connectedDeviceName: Signal<string | undefined> = toSignal(
        this.ergConnectionService.connectionStatus$().pipe(
            filter(
                (status: IErgConnectionStatus): boolean =>
                    status.deviceName !== undefined && status.deviceName.length > 0,
            ),
            map((status: IErgConnectionStatus): string => status.deviceName!),
        ),
        { initialValue: undefined },
    );

    private readonly stopwatch: Stopwatch = new Stopwatch();

    private readonly autoStartEnabled: Signal<boolean> = toSignal(
        this.configManager.configChanged$.pipe(
            map((config: Config): boolean => config.general.session.autoSession !== "off"),
        ),
        { initialValue: true },
    );

    private readonly autoPauseEnabled: Signal<boolean> = toSignal(
        this.configManager.configChanged$.pipe(
            map((config: Config): boolean => config.general.session.autoSession === "autoStartAndPause"),
        ),
        { initialValue: false },
    );

    private hasSeenNonZeroSpeed: boolean = false;
    private readonly resetAutoLap$: Subject<void> = new Subject<void>();

    private indicateStop$: Observable<SessionState> = this.sessionState$.pipe(
        filter((sessionState: SessionState): boolean => sessionState === "stopped"),
    );

    constructor(
        private metricsService: MetricsService,
        private dataRecorder: DataRecorderService,
        private ergConnectionService: ErgConnectionService,
        private configManager: ConfigManagerService,
        private intervalsService: IntervalsIcuService,
        private snackBar: MatSnackBar,
    ) {
        this.sessionState = toSignal(this.sessionState$, { requireSync: true });
        this.elapsedTime = this._elapsedTime.asReadonly();

        this.sessionUpdates$ = this.sessionState$.pipe(
            // suppress paused→running so the existing scan accumulator survives resume
            distinctUntilChanged(
                (prev: SessionState, curr: SessionState): boolean =>
                    prev === curr || (prev === "paused" && curr === "running"),
            ),
            filter((state: SessionState): boolean => state === "running"),
            withLatestFrom(this.sessionSeed),
            map(([, seedRaw]: [SessionState, IRawCalculatedMetrics]): SessionAccumulator => ({
                sessionMetrics: { ...seedRaw, distance: 0, strokeCount: 0, totalWork: 0 },
                previousRawMetrics: seedRaw,
                previousSourceEpoch: 0,
                activeSourceKey: undefined,
                sourceRecords: new Map<string, SessionStrokeRecord>(),
                displayForceCurve: undefined,
                update: undefined,
            })),
            switchMap((seed: SessionAccumulator): Observable<SessionUpdate> =>
                this.streamStrokeMetricUpdates$().pipe(
                    filter(
                        (): boolean => this.sessionState() === "running" || this.sessionState() === "paused",
                    ),
                    scan(
                        (acc: SessionAccumulator, curr: IStrokeMetricUpdate): SessionAccumulator =>
                            this.sessionState() === "paused"
                                ? {
                                      ...acc,
                                      previousRawMetrics: curr.metrics,
                                      previousSourceEpoch: curr.sourceEpoch,
                                  }
                                : SessionManagerService.applyStrokeMetricUpdate(acc, curr),
                        seed,
                    ),
                    filter((): boolean => this.sessionState() === "running"),
                    map(
                        (accumulator: SessionAccumulator): SessionUpdate =>
                            accumulator.update ?? { metrics: accumulator.sessionMetrics },
                    ),
                    startWith({ metrics: seed.sessionMetrics }),
                    takeUntil(this.indicateStop$),
                ),
            ),
            shareReplay({ bufferSize: 1, refCount: true }),
        );

        this.sessionMetrics$ = this.sessionUpdates$.pipe(
            map((update: SessionUpdate): ICalculatedMetrics => update.metrics),
            distinctUntilChanged(SessionManagerService.areSessionMetricsEqual),
            shareReplay({ bufferSize: 1, refCount: true }),
        );

        this.currentStrokeCount = toSignal(
            this.sessionMetrics$.pipe(map((metrics: ICalculatedMetrics): number => metrics.strokeCount)),
            { initialValue: 0 },
        );

        this.sessionState$
            .pipe(
                switchMap((state: SessionState): typeof EMPTY | ReturnType<typeof interval> =>
                    state === "running" ? interval(1000) : EMPTY,
                ),
                takeUntilDestroyed(),
            )
            .subscribe((): void => {
                this._elapsedTime.set(this.stopwatch.elapsedSeconds());
            });

        this.setupAutoStart();
        this.setupRecording();
        this.setupAutoLap();
        this.setupAutoPause();
    }

    addLap(): void {
        if (this.sessionState() !== "running") {
            return;
        }
        this.resetAutoLap$.next();
        void this.dataRecorder.addLap(this.currentStrokeCount(), "manual");
        this.lapCount.update((count: number): number => count + 1);
        this.snackBar.open(`Lap ${this.lapCount()}`, "Dismiss", { duration: 3000 });
    }

    start(timeOffset: number = 0): void {
        if (this.sessionState() === "running") {
            return;
        }

        if (this.sessionState() === "paused") {
            this.stopwatch.start(timeOffset);
            this._elapsedTime.set(this.stopwatch.elapsedSeconds());
            this.sessionState$.next("running");

            return;
        }

        this.stopwatch.start(timeOffset);
        this._elapsedTime.set(this.stopwatch.elapsedSeconds());
        this.dataRecorder.reset(this.connectedDeviceName());
        this.sessionState$.next("running");
    }

    pause(): void {
        if (this.sessionState() !== "running") {
            return;
        }

        void this.dataRecorder.addLap(this.currentStrokeCount(), "manual", true);
        this.stopwatch.pause();
        this.sessionState$.next("paused");
    }

    stop(): void {
        if (this.sessionState() !== "running" && this.sessionState() !== "paused") {
            return;
        }

        const sessionId = this.dataRecorder.currentSessionId;
        this.hasSeenNonZeroSpeed = false;
        this.lapCount.set(0);
        this.stopwatch.stop();
        this.sessionState$.next("stopped");
        void this.handleAutoUpload(sessionId);
    }

    private async handleAutoUpload(sessionId: number): Promise<void> {
        const { intervalsIcu }: { intervalsIcu: IIntervalsIcuConfig } =
            this.configManager.getGroup("general");

        if (!intervalsIcu.autoUploadEnabled || !intervalsIcu.apiKey) {
            return;
        }
        await this.intervalsService.uploadSession(sessionId, intervalsIcu);
    }

    private setupAutoStart(): void {
        this.metricsService.rawMetrics$
            .pipe(
                startWith(ZERO_RAW_METRICS),
                pairwise(),
                filter(
                    ([prev, curr]: [IRawCalculatedMetrics, IRawCalculatedMetrics]): boolean =>
                        this.autoStartEnabled() &&
                        this.sessionState() !== "running" &&
                        (curr.rawStrokeCount > prev.rawStrokeCount ||
                            (curr.rawStrokeCount > 0 && curr.rawStrokeCount < prev.rawStrokeCount)),
                ),
                takeUntilDestroyed(),
            )
            .subscribe(([prev, curr]: [IRawCalculatedMetrics, IRawCalculatedMetrics]): void => {
                if (this.sessionState() === "paused") {
                    this.start(curr.driveDuration * 1000);

                    return;
                }

                // if device resets while stopped treat the new data as overflown and that current is the full delta, hence set seed to 0
                const prevForSeed: IRawCalculatedMetrics =
                    curr.rawStrokeCount < prev.rawStrokeCount
                        ? { ...prev, rawDistance: 0, rawStrokeCount: 0 }
                        : prev;
                this.autoStartSeed$.next(prevForSeed);
                this.start(curr.driveDuration * 1000);
            });
    }

    private setupRecording(): void {
        this.sessionUpdates$
            .pipe(
                filter(
                    (
                        update: SessionUpdate,
                    ): update is SessionUpdate & { record: ICalculatedMetrics } => update.record !== undefined,
                ),
                withLatestFrom(this.metricsService.heartRateData$),
                filter((): boolean => this.sessionState() === "running"),
                takeUntilDestroyed(),
            )
            .subscribe(([update, heartRate]: [SessionUpdate & { record: ICalculatedMetrics }, IHeartRate | undefined]): void => {
                this.dataRecorder.addSessionData(
                    this.toSessionData(update.record, this.stopwatch.elapsedSeconds(), heartRate),
                );
            });

        this.sessionMetrics$
            .pipe(
                filter(
                    (metrics: ICalculatedMetrics): boolean => metrics.strokeCount > 0 || metrics.distance > 0,
                ),
                switchMap((metrics: ICalculatedMetrics): Observable<[ICalculatedMetrics, number]> =>
                    combineLatest([of(metrics), interval(1000)]).pipe(
                        takeUntil(this.indicateStop$),
                    ),
                ),
                map(([metrics]: [ICalculatedMetrics, number]): ICalculatedMetrics => metrics),
                withLatestFrom(this.metricsService.heartRateData$),
                filter((): boolean => this.sessionState() === "running"),
                takeUntilDestroyed(),
            )
            .subscribe(([metrics, heartRate]: [ICalculatedMetrics, IHeartRate | undefined]): void => {
                this.dataRecorder.addSessionData(
                    this.toSessionData(metrics, this.stopwatch.elapsedSeconds(), heartRate),
                );
            });
    }

    private setupAutoLap(): void {
        let lastLapValue = 0;

        merge(
            this.resetAutoLap$,
            this.configManager.configChanged$.pipe(
                map((config: Config): AutoLapMode => config.general.session.autoLap),
                distinctUntilChanged(),
            ),
        )
            .pipe(
                withLatestFrom(this.sessionMetrics$, this.configManager.configChanged$),
                takeUntilDestroyed(),
            )
            .subscribe(([, metrics, config]: [unknown, ICalculatedMetrics, Config]): void => {
                lastLapValue =
                    config.general.session.autoLap === "distance"
                        ? metrics.distance / 100
                        : this.stopwatch.elapsedSeconds() / 60;
            });

        this.sessionMetrics$
            .pipe(
                withLatestFrom(this.configManager.configChanged$),
                filter(
                    ([, config]: [ICalculatedMetrics, Config]): boolean =>
                        config.general.session.autoLap !== "off",
                ),
                filter(([metrics, config]: [ICalculatedMetrics, Config]): boolean => {
                    const currentValue =
                        config.general.session.autoLap === "distance"
                            ? metrics.distance / 100
                            : this.stopwatch.elapsedSeconds() / 60;

                    if (currentValue < lastLapValue) {
                        lastLapValue = currentValue;
                    }

                    if (currentValue - lastLapValue >= config.general.session.autoLapValue) {
                        lastLapValue += config.general.session.autoLapValue;

                        return true;
                    }

                    return false;
                }),
                takeUntilDestroyed(),
            )
            .subscribe(([metrics, config]: [ICalculatedMetrics, Config]): void => {
                void this.dataRecorder.addLap(
                    metrics.strokeCount,
                    config.general.session.autoLap as Exclude<AutoLapMode, "off">,
                );
                this.lapCount.update((count: number): number => count + 1);
                this.snackBar.open(`Lap ${this.lapCount()}`, "Dismiss", { duration: 3000 });
            });
    }

    private setupAutoPause(): void {
        this.metricsService.rawMetrics$
            .pipe(
                filter((): boolean => this.autoPauseEnabled() && this.sessionState() === "running"),
                takeUntilDestroyed(),
            )
            .subscribe((metrics: IRawCalculatedMetrics): void => {
                if (metrics.speed > 0) {
                    this.hasSeenNonZeroSpeed = true;

                    return;
                }

                if (!this.hasSeenNonZeroSpeed) {
                    return;
                }

                this.pause();
            });
    }

    private streamStrokeMetricUpdates$(): Observable<IStrokeMetricUpdate> {
        const updates = (this.metricsService as Partial<MetricsService>).strokeMetricUpdates$;
        if (updates !== undefined) {
            return updates;
        }

        // Existing test doubles and older integrations expose rawMetrics$ only.
        // Preserve their semantics while the production service supplies the
        // richer stroke-keyed event stream.
        return this.metricsService.rawMetrics$.pipe(
            scan<IRawCalculatedMetrics, FallbackMetricState>(
                (
                    state: FallbackMetricState,
                    metrics: IRawCalculatedMetrics,
                ): FallbackMetricState => ({
                    epoch:
                        state.previous !== undefined && metrics.rawStrokeCount < state.previous.rawStrokeCount
                            ? state.epoch + 1
                            : state.epoch,
                    previous: metrics,
                }),
                { epoch: 0, previous: undefined },
            ),
            filter(
                (state: FallbackMetricState): state is FallbackMetricState & { previous: IRawCalculatedMetrics } =>
                    state.previous !== undefined,
            ),
            map(
                (state: FallbackMetricState & { previous: IRawCalculatedMetrics }): IStrokeMetricUpdate => ({
                    sourceEpoch: state.epoch,
                    sourceStrokeId: state.previous.rawStrokeCount,
                    isBaseMetric: true,
                    isCurrentStroke: true,
                    metrics: state.previous,
                }),
            ),
        );
    }

    private toSessionData(
        metrics: ICalculatedMetrics,
        elapsedTime: number,
        heartRate: IHeartRate | undefined,
    ): ISessionData {
        const {
            rawDistance: _rawDistance,
            rawStrokeCount: _rawStrokeCount,
            displayForceCurve,
            ...sessionMetrics
        } = metrics as ICalculatedMetrics & Pick<IRawCalculatedMetrics, "rawDistance" | "rawStrokeCount">;

        return { ...sessionMetrics, elapsedTime, heartRate };
    }

    private static applyStrokeMetricUpdate(
        accumulator: SessionAccumulator,
        sourceUpdate: IStrokeMetricUpdate,
    ): SessionAccumulator {
        const sourceKey = `${sourceUpdate.sourceEpoch}:${sourceUpdate.sourceStrokeId}`;
        const existingRecord = accumulator.sourceRecords.get(sourceKey);

        if (sourceUpdate.isBaseMetric && existingRecord === undefined) {
            return SessionManagerService.addSessionStroke(accumulator, sourceUpdate, sourceKey);
        }

        if (existingRecord === undefined) {
            // A supplement for data that predates this session is not a new
            // session stroke and must not be accumulated into it.
            return { ...accumulator, update: undefined };
        }

        return SessionManagerService.updateSessionStroke(accumulator, sourceUpdate, sourceKey, existingRecord);
    }

    private static addSessionStroke(
        accumulator: SessionAccumulator,
        sourceUpdate: IStrokeMetricUpdate,
        sourceKey: string,
    ): SessionAccumulator {
        const currentMetrics = sourceUpdate.metrics;
        const isSeedReplay =
            accumulator.sourceRecords.size === 0 &&
            sourceUpdate.sourceEpoch === accumulator.previousSourceEpoch &&
            currentMetrics.rawStrokeCount === accumulator.previousRawMetrics.rawStrokeCount &&
            currentMetrics.rawDistance === accumulator.previousRawMetrics.rawDistance;
        if (isSeedReplay) {
            // Starting a new session subscribes to replayed BLE streams. The
            // first replay describes the pre-session baseline, not a stroke
            // that belongs in the new recording.
            return { ...accumulator, update: undefined };
        }
        if (currentMetrics.rawStrokeCount === 0 && currentMetrics.rawDistance === 0) {
            return {
                ...accumulator,
                previousRawMetrics: currentMetrics,
                previousSourceEpoch: sourceUpdate.sourceEpoch,
                update: undefined,
            };
        }
        const isSameEpoch = sourceUpdate.sourceEpoch === accumulator.previousSourceEpoch;
        const previousRawMetrics = accumulator.previousRawMetrics;
        const previousDistance =
            !isSameEpoch || currentMetrics.rawDistance < previousRawMetrics.rawDistance
                ? 0
                : previousRawMetrics.rawDistance;
        const previousStrokeCount =
            !isSameEpoch || currentMetrics.rawStrokeCount < previousRawMetrics.rawStrokeCount
                ? 0
                : previousRawMetrics.rawStrokeCount;
        const distance =
            accumulator.sessionMetrics.distance + Math.max(0, currentMetrics.rawDistance - previousDistance);
        const strokeCount =
            accumulator.sessionMetrics.strokeCount +
            Math.max(0, currentMetrics.rawStrokeCount - previousStrokeCount);
        const work = SessionManagerService.calculateStrokeWork(currentMetrics);
        const totalWork = accumulator.sessionMetrics.totalWork + work;
        const displayForceCurve =
            SessionManagerService.toDisplayForceCurve(sourceUpdate) ?? accumulator.displayForceCurve;
        const recordMetrics: ICalculatedMetrics = {
            ...currentMetrics,
            distance,
            strokeCount,
            totalWork,
            displayForceCurve,
        };
        const sourceRecords = new Map(accumulator.sourceRecords);
        sourceRecords.set(sourceKey, {
            distance,
            strokeCount,
            work,
            rawDistance: currentMetrics.rawDistance,
            metrics: recordMetrics,
        });

        return {
            ...accumulator,
            sessionMetrics: recordMetrics,
            previousRawMetrics: currentMetrics,
            previousSourceEpoch: sourceUpdate.sourceEpoch,
            activeSourceKey: sourceKey,
            sourceRecords,
            displayForceCurve,
            update: { metrics: recordMetrics, record: recordMetrics },
        };
    }

    private static updateSessionStroke(
        accumulator: SessionAccumulator,
        sourceUpdate: IStrokeMetricUpdate,
        sourceKey: string,
        existingRecord: SessionStrokeRecord,
    ): SessionAccumulator {
        const currentMetrics = sourceUpdate.metrics;
        const newWork = SessionManagerService.calculateStrokeWork(currentMetrics);
        const totalWork = accumulator.sessionMetrics.totalWork - existingRecord.work + newWork;
        const distanceDelta =
            sourceUpdate.isBaseMetric && sourceUpdate.isCurrentStroke
                ? Math.max(0, currentMetrics.rawDistance - existingRecord.rawDistance)
                : 0;
        const distance = existingRecord.distance + distanceDelta;
        const displayForceCurve =
            SessionManagerService.toDisplayForceCurve(sourceUpdate) ?? accumulator.displayForceCurve;
        const recordMetrics: ICalculatedMetrics = {
            ...existingRecord.metrics,
            ...currentMetrics,
            distance,
            strokeCount: existingRecord.strokeCount,
            totalWork,
            displayForceCurve,
        };
        if (SessionManagerService.areSessionMetricsEqual(existingRecord.metrics, recordMetrics)) {
            return { ...accumulator, update: undefined };
        }
        const sourceRecords = new Map(accumulator.sourceRecords);
        sourceRecords.set(sourceKey, {
            distance,
            strokeCount: existingRecord.strokeCount,
            work: newWork,
            rawDistance: sourceUpdate.isBaseMetric ? currentMetrics.rawDistance : existingRecord.rawDistance,
            metrics: recordMetrics,
        });
        const isActiveSource = accumulator.activeSourceKey === sourceKey;
        const sessionMetrics: ICalculatedMetrics = isActiveSource
            ? recordMetrics
            : {
                  ...accumulator.sessionMetrics,
                  totalWork,
                  displayForceCurve,
              };

        return {
            ...accumulator,
            sessionMetrics,
            previousRawMetrics:
                sourceUpdate.isBaseMetric && sourceUpdate.isCurrentStroke
                    ? currentMetrics
                    : accumulator.previousRawMetrics,
            previousSourceEpoch:
                sourceUpdate.isBaseMetric && sourceUpdate.isCurrentStroke
                    ? sourceUpdate.sourceEpoch
                    : accumulator.previousSourceEpoch,
            sourceRecords,
            displayForceCurve,
            update: { metrics: sessionMetrics, record: recordMetrics },
        };
    }

    private static calculateStrokeWork(metrics: IRawCalculatedMetrics): number {
        if (metrics.isExtendedMetricsPending === true) {
            return 0;
        }

        return metrics.avgStrokePower * (metrics.driveDuration + metrics.recoveryDuration);
    }

    private static toDisplayForceCurve(sourceUpdate: IStrokeMetricUpdate): IDisplayForceCurve | undefined {
        const { metrics } = sourceUpdate;
        if (metrics.forceCurve === undefined || metrics.forceCurveStatus !== "complete") {
            return undefined;
        }

        return {
            strokeId: metrics.forceCurveStrokeId ?? sourceUpdate.sourceStrokeId,
            driveLength: metrics.driveLength,
            driveDuration: metrics.driveDuration,
            samples: metrics.forceCurve,
            isDriveLengthAnomalous: metrics.isDriveLengthAnomalous === true,
        };
    }

    private static areSessionMetricsEqual(
        previousMetrics: ICalculatedMetrics,
        currentMetrics: ICalculatedMetrics,
    ): boolean {
        const {
            avgStrokePower,
            distance,
            strokeCount,
            totalWork,
            driveDuration,
            recoveryDuration,
            dragFactor,
            strokeRate,
            speed,
            distPerStroke,
            driveLength,
            peakForce,
            peakForcePositionNorm,
            powerBalance,
            forceCurveStatus,
            forceCurve,
            displayForceCurve,
            isDriveLengthAnomalous,
            isExtendedMetricsPending,
        } = previousMetrics;

        return (
            avgStrokePower === currentMetrics.avgStrokePower &&
            distance === currentMetrics.distance &&
            strokeCount === currentMetrics.strokeCount &&
            totalWork === currentMetrics.totalWork &&
            driveDuration === currentMetrics.driveDuration &&
            recoveryDuration === currentMetrics.recoveryDuration &&
            dragFactor === currentMetrics.dragFactor &&
            strokeRate === currentMetrics.strokeRate &&
            speed === currentMetrics.speed &&
            distPerStroke === currentMetrics.distPerStroke &&
            driveLength === currentMetrics.driveLength &&
            peakForce === currentMetrics.peakForce &&
            peakForcePositionNorm === currentMetrics.peakForcePositionNorm &&
            powerBalance === currentMetrics.powerBalance &&
            forceCurveStatus === currentMetrics.forceCurveStatus &&
            forceCurve === currentMetrics.forceCurve &&
            displayForceCurve === currentMetrics.displayForceCurve &&
            isDriveLengthAnomalous === currentMetrics.isDriveLengthAnomalous &&
            isExtendedMetricsPending === currentMetrics.isExtendedMetricsPending
        );
    }
}
