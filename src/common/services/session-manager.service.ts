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
    IForceCurve,
    IHeartRate,
    IIntervalsIcuConfig,
    IRawCalculatedMetrics,
    ISessionCalculatedMetrics,
    ISessionData,
    SessionState,
} from "../common.interfaces";
import { IStrokePersistenceIdentity } from "../database.interfaces";
import { Stopwatch } from "../utils/stopwatch";

import { ConfigManagerService } from "./config-manager.service";
import { DataRecorderService } from "./data-recorder.service";
import { ErgConnectionService } from "./ergometer/erg-connection.service";
import { IntervalsIcuService } from "./intervals-icu.service";
import { MetricsService } from "./metrics.service";

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
    sessionMetrics: ISessionCalculatedMetrics;
    previousRawMetrics: IRawCalculatedMetrics;
    sourceRecords: Map<string, SessionStrokeRecord>;
    activeSourceKey?: string;
    hasInitialLegacyBaseline: boolean;
    lastCompleteDisplayCurve?: IDisplayForceCurve;
    lastCompleteCurveSequence: number;
    nextStrokeSequence: number;
    v2RowUpdate?: V2SessionRowUpdate;
}

interface SessionStrokeRecord {
    sourceEpoch: number;
    sourceStrokeId: number;
    metrics: IRawCalculatedMetrics;
    rowMetrics?: ISessionCalculatedMetrics;
    isSessionStroke: boolean;
    workContribution: number;
    sequence: number;
}

interface SessionMetricInput {
    metrics: IRawCalculatedMetrics;
    source: "legacy" | "v2";
    isCurrentStroke: boolean;
}

interface V2SessionRowUpdate {
    metrics: ISessionCalculatedMetrics;
    sourceEpoch: number;
    sourceStrokeId: number;
}

interface SessionProgress {
    sessionMetrics: ISessionCalculatedMetrics;
    displayMetrics?: ISessionCalculatedMetrics;
    v2RowUpdate?: V2SessionRowUpdate;
}

const MAX_SESSION_STROKE_RECORDS = 256;
const UINT16_RANGE = 0x10000;
const UINT16_HALF_RANGE = UINT16_RANGE / 2;
const DRIVE_LENGTH_ANOMALY_THRESHOLD_METERS = 5;

@Injectable({
    providedIn: "root",
})
export class SessionManagerService {
    readonly sessionState: Signal<SessionState>;
    readonly elapsedTime: Signal<number>;
    readonly sessionMetrics$: Observable<ISessionCalculatedMetrics>;
    readonly displayMetrics$: Observable<ISessionCalculatedMetrics>;

    private sessionState$: BehaviorSubject<SessionState> = new BehaviorSubject<SessionState>("stopped");
    private _elapsedTime: WritableSignal<number> = signal<number>(0);
    private readonly lapCount: WritableSignal<number> = signal<number>(0);
    private readonly currentStrokeCount: Signal<number>;
    private readonly sessionProgress$: Observable<SessionProgress>;
    private readonly sessionMetricInput$: Observable<SessionMetricInput>;

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

        this.sessionMetricInput$ = this.createSessionMetricInputStream();
        this.sessionProgress$ = this.sessionState$.pipe(
            // suppress paused→running so the existing scan accumulator survives resume
            distinctUntilChanged(
                (prev: SessionState, curr: SessionState): boolean =>
                    prev === curr || (prev === "paused" && curr === "running"),
            ),
            filter((state: SessionState): boolean => state === "running"),
            withLatestFrom(this.sessionSeed),
            map(([, seedRaw]: [SessionState, IRawCalculatedMetrics]): SessionAccumulator =>
                this.createSessionAccumulator(seedRaw),
            ),
            switchMap((seed: SessionAccumulator): Observable<SessionProgress> =>
                this.sessionMetricInput$.pipe(
                    filter(
                        (): boolean => this.sessionState() === "running" || this.sessionState() === "paused",
                    ),
                    scan(
                        (acc: SessionAccumulator, curr: SessionMetricInput): SessionAccumulator =>
                            this.accumulateSessionInput(acc, curr, this.sessionState() === "paused"),
                        seed,
                    ),
                    filter((): boolean => this.sessionState() === "running"),
                    map((acc: SessionAccumulator): SessionProgress => ({
                        sessionMetrics: acc.sessionMetrics,
                        displayMetrics: SessionManagerService.completedRecoveryDisplay(acc),
                        v2RowUpdate: acc.v2RowUpdate,
                    })),
                    distinctUntilChanged(
                        (previous: SessionProgress, current: SessionProgress): boolean =>
                            previous.v2RowUpdate === undefined &&
                            current.v2RowUpdate === undefined &&
                            SessionManagerService.areSessionMetricsEqual(
                                previous.sessionMetrics,
                                current.sessionMetrics,
                            ),
                    ),
                    startWith({ sessionMetrics: seed.sessionMetrics }),
                    takeUntil(this.indicateStop$),
                ),
            ),
            shareReplay({ bufferSize: 1, refCount: true }),
        );
        this.sessionMetrics$ = this.sessionProgress$.pipe(
            map((progress: SessionProgress): ISessionCalculatedMetrics => progress.sessionMetrics),
            distinctUntilChanged(SessionManagerService.areSessionMetricsEqual),
            shareReplay({ bufferSize: 1, refCount: true }),
        );

        this.displayMetrics$ = this.sessionProgress$.pipe(
            map(
                (progress: SessionProgress): ISessionCalculatedMetrics =>
                    progress.displayMetrics ?? progress.sessionMetrics,
            ),
            shareReplay({ bufferSize: 1, refCount: true }),
        );

        this.currentStrokeCount = toSignal(
            this.sessionMetrics$.pipe(
                map((metrics: ISessionCalculatedMetrics): number => metrics.strokeCount),
            ),
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
        void this.dataRecorder.finishSession(sessionId, Date.now(), this.stopwatch.elapsedSeconds());
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
                        SessionManagerService.isNewStrokeObservation(prev, curr),
                ),
                takeUntilDestroyed(),
            )
            .subscribe(([prev, curr]: [IRawCalculatedMetrics, IRawCalculatedMetrics]): void => {
                if (this.sessionState() === "paused") {
                    this.start(curr.driveDuration * 1000);

                    return;
                }

                this.autoStartSeed$.next(SessionManagerService.seedImmediatelyBeforeStroke(prev, curr));
                this.start(curr.driveDuration * 1000);
            });
    }

    private createSessionMetricInputStream(): Observable<SessionMetricInput> {
        const latestMetrics$: Observable<IRawCalculatedMetrics> = this.metricsService.rawMetrics$;
        const keyedMetrics$ = (
            this.metricsService as MetricsService & {
                strokeMetricUpdates$?: Observable<IRawCalculatedMetrics>;
            }
        ).strokeMetricUpdates$;
        const legacyMetrics$: Observable<SessionMetricInput> = latestMetrics$.pipe(
            filter(
                (metrics: IRawCalculatedMetrics): boolean =>
                    metrics.sourceEpoch === undefined || metrics.sourceStrokeId === undefined,
            ),
            map((metrics: IRawCalculatedMetrics): SessionMetricInput => ({
                metrics,
                source: "legacy",
                isCurrentStroke: true,
            })),
        );
        const v2Metrics$: Observable<SessionMetricInput> = (keyedMetrics$ ?? EMPTY).pipe(
            withLatestFrom(latestMetrics$),
            filter(
                ([metrics, currentMetrics]: [IRawCalculatedMetrics, IRawCalculatedMetrics]): boolean =>
                    metrics.sourceEpoch !== undefined &&
                    metrics.sourceStrokeId !== undefined &&
                    currentMetrics.sourceEpoch !== undefined &&
                    currentMetrics.sourceStrokeId !== undefined,
            ),
            map(
                ([metrics, currentMetrics]: [
                    IRawCalculatedMetrics,
                    IRawCalculatedMetrics,
                ]): SessionMetricInput => ({
                    metrics,
                    source: "v2",
                    isCurrentStroke:
                        metrics.sourceEpoch === currentMetrics.sourceEpoch &&
                        metrics.sourceStrokeId === currentMetrics.sourceStrokeId,
                }),
            ),
        );

        return merge(legacyMetrics$, v2Metrics$);
    }

    private createSessionAccumulator(seedRaw: IRawCalculatedMetrics): SessionAccumulator {
        const sourceRecords: Map<string, SessionStrokeRecord> = new Map<string, SessionStrokeRecord>();
        const hasV2Identity: boolean = SessionManagerService.hasV2Identity(seedRaw);
        const lastCompleteDisplayCurve: IDisplayForceCurve | undefined =
            SessionManagerService.displayCurveFromMetrics(seedRaw);
        const activeSourceKey: string | undefined = hasV2Identity
            ? SessionManagerService.sourceKey(seedRaw.sourceEpoch!, seedRaw.sourceStrokeId!)
            : undefined;
        if (hasV2Identity) {
            sourceRecords.set(activeSourceKey!, {
                sourceEpoch: seedRaw.sourceEpoch!,
                sourceStrokeId: seedRaw.sourceStrokeId!,
                metrics: seedRaw,
                isSessionStroke: false,
                workContribution: 0,
                sequence: 0,
            });
        }

        return {
            sessionMetrics: {
                ...seedRaw,
                distance: 0,
                strokeCount: 0,
                totalWork: 0,
                displayForceCurve: lastCompleteDisplayCurve,
            },
            previousRawMetrics: seedRaw,
            sourceRecords,
            activeSourceKey,
            lastCompleteDisplayCurve,
            lastCompleteCurveSequence: lastCompleteDisplayCurve === undefined ? -1 : 0,
            nextStrokeSequence: 1,
            hasInitialLegacyBaseline:
                !hasV2Identity && seedRaw.rawStrokeCount === 0 && seedRaw.rawDistance === 0,
        };
    }

    private accumulateSessionInput(
        accumulator: SessionAccumulator,
        input: SessionMetricInput,
        isPaused: boolean,
    ): SessionAccumulator {
        const cleanAccumulator: SessionAccumulator = { ...accumulator, v2RowUpdate: undefined };
        if (input.source === "v2") {
            return SessionManagerService.accumulateV2Metrics(
                cleanAccumulator,
                input.metrics,
                input.isCurrentStroke,
                isPaused,
            );
        }

        if (isPaused) {
            return {
                ...cleanAccumulator,
                previousRawMetrics: input.metrics,
                hasInitialLegacyBaseline: false,
            };
        }

        return SessionManagerService.accumulateLegacyMetrics(cleanAccumulator, input.metrics);
    }

    private setupRecording(): void {
        this.sessionMetrics$
            .pipe(
                filter(
                    (metrics: ISessionCalculatedMetrics): boolean =>
                        metrics.sourceEpoch === undefined &&
                        metrics.sourceStrokeId === undefined &&
                        (metrics.strokeCount > 0 || metrics.distance > 0),
                ),
                switchMap(
                    (metrics: ISessionCalculatedMetrics): Observable<[ISessionCalculatedMetrics, number]> =>
                        combineLatest([of(metrics), interval(1000).pipe(startWith(0))]).pipe(
                            takeUntil(this.indicateStop$),
                        ),
                ),
                map(([metrics]: [ISessionCalculatedMetrics, number]): ISessionCalculatedMetrics => metrics),
                withLatestFrom(this.metricsService.heartRateData$),
                filter((): boolean => this.sessionState() === "running"),
                takeUntilDestroyed(),
            )
            .subscribe(([metrics, heartRate]: [ISessionCalculatedMetrics, IHeartRate | undefined]): void => {
                this.dataRecorder.addSessionData({
                    ...metrics,
                    elapsedTime: this.stopwatch.elapsedSeconds(),
                    heartRate,
                });
            });

        this.sessionProgress$
            .pipe(
                map((progress: SessionProgress): V2SessionRowUpdate | undefined => progress.v2RowUpdate),
                filter(
                    (update: V2SessionRowUpdate | undefined): update is V2SessionRowUpdate =>
                        update !== undefined,
                ),
                withLatestFrom(this.metricsService.heartRateData$),
                filter((): boolean => this.sessionState() === "running"),
                takeUntilDestroyed(),
            )
            .subscribe(([update, heartRate]: [V2SessionRowUpdate, IHeartRate | undefined]): void => {
                const { displayForceCurve: _displayForceCurve, ...strokeMetrics }: ISessionCalculatedMetrics =
                    update.metrics;
                const rowingData: ISessionData = {
                    ...strokeMetrics,
                    elapsedTime: this.stopwatch.elapsedSeconds(),
                    heartRate,
                };
                const identity: IStrokePersistenceIdentity = {
                    sourceEpoch: update.sourceEpoch,
                    sourceStrokeId: update.sourceStrokeId,
                    forceCurve: rowingData.forceCurve,
                    forceCurveStatus: rowingData.forceCurveStatus,
                    isExtendedMetricsPending: rowingData.isExtendedMetricsPending,
                };
                void this.dataRecorder.upsertSessionStroke(rowingData, identity);
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

    /** Late recovery belongs to its original row, but can be the latest completed value on the dashboard. */
    private static completedRecoveryDisplay(accumulator: SessionAccumulator): ISessionCalculatedMetrics {
        const current = accumulator.sessionMetrics;
        if (current.isExtendedMetricsPending !== true || current.strokeCount === 0) return current;
        let latest: SessionStrokeRecord | undefined;
        for (const record of accumulator.sourceRecords.values()) {
            if (
                record.isSessionStroke &&
                record.sourceEpoch === current.sourceEpoch &&
                record.metrics.isExtendedMetricsPending === false &&
                (latest === undefined || record.sequence > latest.sequence)
            )
                latest = record;
        }
        if (latest === undefined) return current;

        return {
            ...current,
            avgStrokePower: latest.metrics.avgStrokePower,
            recoveryDuration: latest.metrics.recoveryDuration,
            dragFactor: latest.metrics.dragFactor,
            isExtendedMetricsPending: false,
        };
    }

    private static accumulateLegacyMetrics(
        accumulator: SessionAccumulator,
        currentMetrics: IRawCalculatedMetrics,
    ): SessionAccumulator {
        if (!SessionManagerService.hasValidRawCounters(currentMetrics)) {
            console.error("Ignoring invalid legacy session metrics", currentMetrics);

            return accumulator;
        }

        const previousMetrics: IRawCalculatedMetrics = accumulator.previousRawMetrics;
        const currentRawCount: number = currentMetrics.rawStrokeCount;
        const previousRawCount: number = previousMetrics.rawStrokeCount;
        const currentDistance: number = currentMetrics.rawDistance;
        const previousDistance: number = previousMetrics.rawDistance;
        let strokeDelta = 0;
        let distanceDelta = 0;

        if (
            accumulator.hasInitialLegacyBaseline &&
            previousRawCount === 0 &&
            previousDistance === 0 &&
            currentRawCount > 0
        ) {
            strokeDelta = 1;
            distanceDelta = SessionManagerService.currentStrokeDistanceCm(currentMetrics);
        } else if (currentDistance < previousDistance) {
            console.warn("Legacy distance counter reset/regressed; starting a new distance segment", {
                previous: previousMetrics,
                current: currentMetrics,
            });
            strokeDelta =
                currentRawCount < previousRawCount ? currentRawCount : currentRawCount - previousRawCount;
            distanceDelta = currentDistance;
        } else if (currentRawCount < previousRawCount) {
            const wrapDelta: number = (currentRawCount - previousRawCount + UINT16_RANGE) % UINT16_RANGE;
            if (
                previousRawCount >= UINT16_RANGE - UINT16_HALF_RANGE &&
                currentRawCount < UINT16_HALF_RANGE &&
                wrapDelta > 0
            ) {
                strokeDelta = wrapDelta;
                distanceDelta = currentDistance - previousDistance;
            } else {
                console.error("Ignoring legacy stroke counter regression without a reset", {
                    previous: previousMetrics,
                    current: currentMetrics,
                });

                return accumulator;
            }
        } else {
            strokeDelta = currentRawCount - previousRawCount;
            distanceDelta = currentDistance - previousDistance;
        }

        if (
            !Number.isFinite(strokeDelta) ||
            strokeDelta < 0 ||
            !Number.isFinite(distanceDelta) ||
            distanceDelta < 0
        ) {
            console.error("Ignoring invalid legacy metric deltas", { strokeDelta, distanceDelta });

            return accumulator;
        }

        const {
            rawDistance: _rawDistance,
            rawStrokeCount: _rawStrokeCount,
            ...currentRest
        }: IRawCalculatedMetrics = currentMetrics;
        const workDelta: number =
            strokeDelta > 0 && Number.isFinite(currentMetrics.avgStrokePower)
                ? SessionManagerService.legacyWorkContribution(currentMetrics)
                : 0;

        return {
            ...accumulator,
            sessionMetrics: {
                ...currentRest,
                distance: accumulator.sessionMetrics.distance + distanceDelta,
                strokeCount: accumulator.sessionMetrics.strokeCount + strokeDelta,
                totalWork: accumulator.sessionMetrics.totalWork + workDelta,
            },
            previousRawMetrics: currentMetrics,
            hasInitialLegacyBaseline: false,
        };
    }

    private static accumulateV2Metrics(
        accumulator: SessionAccumulator,
        incoming: IRawCalculatedMetrics,
        isCurrentStroke: boolean,
        isPaused: boolean,
    ): SessionAccumulator {
        if (!SessionManagerService.hasValidV2Metrics(incoming)) {
            console.error("Ignoring invalid keyed session metrics", incoming);

            return accumulator;
        }

        const sourceEpoch: number = incoming.sourceEpoch!;
        const sourceStrokeId: number = incoming.sourceStrokeId!;
        const key: string = SessionManagerService.sourceKey(sourceEpoch, sourceStrokeId);
        const records: Map<string, SessionStrokeRecord> = new Map(accumulator.sourceRecords);
        const existing: SessionStrokeRecord | undefined = records.get(key);

        if (existing !== undefined) {
            return SessionManagerService.updateExistingV2Record(
                accumulator,
                incoming,
                existing,
                records,
                key,
            );
        }

        if (!isCurrentStroke) {
            console.warn("Ignoring late keyed metrics for a stroke outside the session cache", {
                sourceEpoch,
                sourceStrokeId,
            });

            return accumulator;
        }

        if (isPaused) {
            return SessionManagerService.recordPausedV2Stroke(
                accumulator,
                incoming,
                sourceEpoch,
                sourceStrokeId,
                key,
                records,
            );
        }

        // the assembler starts a fresh epoch on reconnect. Its first Base packet
        // has no preceding Base in that epoch, so its key alone cannot mean a
        // new stroke. Use the device counter to establish a new baseline.
        if (
            accumulator.previousRawMetrics.sourceEpoch !== undefined &&
            accumulator.previousRawMetrics.sourceEpoch !== sourceEpoch &&
            !SessionManagerService.rawStrokeCounterAdvanced(accumulator.previousRawMetrics, incoming)
        ) {
            return SessionManagerService.recordV2EpochBaseline(accumulator, incoming, key, records);
        }

        return SessionManagerService.addV2SessionStroke(
            accumulator,
            incoming,
            sourceEpoch,
            sourceStrokeId,
            key,
            records,
        );
    }

    private static recordV2EpochBaseline(
        accumulator: SessionAccumulator,
        incoming: IRawCalculatedMetrics,
        key: string,
        records: Map<string, SessionStrokeRecord>,
    ): SessionAccumulator {
        const previous: IRawCalculatedMetrics = accumulator.previousRawMetrics;
        const coastingDistance: number =
            incoming.rawStrokeCount === previous.rawStrokeCount &&
            incoming.rawDistance >= previous.rawDistance
                ? incoming.rawDistance - previous.rawDistance
                : 0;
        SessionManagerService.setBoundedRecord(records, key, {
            sourceEpoch: incoming.sourceEpoch!,
            sourceStrokeId: incoming.sourceStrokeId!,
            metrics: incoming,
            isSessionStroke: false,
            workContribution: 0,
            sequence: accumulator.nextStrokeSequence,
        });

        return {
            ...accumulator,
            sessionMetrics: {
                ...SessionManagerService.toSessionRowMetrics(
                    incoming,
                    accumulator.sessionMetrics.distance + coastingDistance,
                    accumulator.sessionMetrics.strokeCount,
                    accumulator.sessionMetrics.totalWork,
                ),
                displayForceCurve: accumulator.lastCompleteDisplayCurve,
            },
            previousRawMetrics: incoming,
            sourceRecords: records,
            activeSourceKey: key,
            nextStrokeSequence: accumulator.nextStrokeSequence + 1,
        };
    }

    private static updateExistingV2Record(
        accumulator: SessionAccumulator,
        incoming: IRawCalculatedMetrics,
        existing: SessionStrokeRecord,
        records: Map<string, SessionStrokeRecord>,
        key: string,
    ): SessionAccumulator {
        const mergedMetrics: IRawCalculatedMetrics = SessionManagerService.mergeV2Metrics(
            existing.metrics,
            incoming,
        );
        if (SessionManagerService.rawMetricsEqual(existing.metrics, mergedMetrics)) {
            return { ...accumulator, sourceRecords: records };
        }

        const nextWorkContribution: number = existing.isSessionStroke
            ? SessionManagerService.v2WorkContribution(mergedMetrics)
            : 0;
        const workDifference: number = nextWorkContribution - existing.workContribution;
        const totalWork: number =
            accumulator.sessionMetrics.totalWork + (workDifference > 0 ? workDifference : 0);
        const rowMetrics: ISessionCalculatedMetrics | undefined = existing.rowMetrics
            ? SessionManagerService.toSessionRowMetrics(
                  mergedMetrics,
                  existing.rowMetrics.distance,
                  existing.rowMetrics.strokeCount,
                  totalWork,
              )
            : undefined;
        const updatedRecord: SessionStrokeRecord = {
            ...existing,
            metrics: mergedMetrics,
            rowMetrics,
            workContribution: Math.max(existing.workContribution, nextWorkContribution),
        };
        records.set(key, updatedRecord);
        const incomingDisplayCurve: IDisplayForceCurve | undefined =
            SessionManagerService.displayCurveFromMetrics(mergedMetrics);
        const shouldReplaceDisplayCurve: boolean =
            incomingDisplayCurve !== undefined && existing.sequence >= accumulator.lastCompleteCurveSequence;
        const lastCompleteDisplayCurve: IDisplayForceCurve | undefined = shouldReplaceDisplayCurve
            ? incomingDisplayCurve
            : accumulator.lastCompleteDisplayCurve;
        const lastCompleteCurveSequence: number = shouldReplaceDisplayCurve
            ? existing.sequence
            : accumulator.lastCompleteCurveSequence;
        const nextSessionMetrics: ISessionCalculatedMetrics =
            accumulator.activeSourceKey === key
                ? {
                      ...SessionManagerService.toSessionRowMetrics(
                          mergedMetrics,
                          accumulator.sessionMetrics.distance,
                          accumulator.sessionMetrics.strokeCount,
                          totalWork,
                      ),
                      displayForceCurve: lastCompleteDisplayCurve,
                  }
                : {
                      ...accumulator.sessionMetrics,
                      totalWork,
                      displayForceCurve: lastCompleteDisplayCurve,
                  };
        const v2RowUpdate: V2SessionRowUpdate | undefined =
            existing.isSessionStroke && rowMetrics !== undefined
                ? {
                      metrics: rowMetrics,
                      sourceEpoch: existing.sourceEpoch,
                      sourceStrokeId: existing.sourceStrokeId,
                  }
                : undefined;

        return {
            ...accumulator,
            sessionMetrics: nextSessionMetrics,
            sourceRecords: records,
            lastCompleteDisplayCurve,
            lastCompleteCurveSequence,
            previousRawMetrics:
                accumulator.activeSourceKey === key ? mergedMetrics : accumulator.previousRawMetrics,
            v2RowUpdate,
        };
    }

    private static recordPausedV2Stroke(
        accumulator: SessionAccumulator,
        incoming: IRawCalculatedMetrics,
        sourceEpoch: number,
        sourceStrokeId: number,
        key: string,
        records: Map<string, SessionStrokeRecord>,
    ): SessionAccumulator {
        SessionManagerService.setBoundedRecord(records, key, {
            sourceEpoch,
            sourceStrokeId,
            metrics: incoming,
            isSessionStroke: false,
            workContribution: 0,
            sequence: accumulator.nextStrokeSequence,
        });
        const displayCurve: IDisplayForceCurve | undefined =
            SessionManagerService.displayCurveFromMetrics(incoming) ?? accumulator.lastCompleteDisplayCurve;
        const currentCurveSequence: number =
            SessionManagerService.displayCurveFromMetrics(incoming) === undefined
                ? accumulator.lastCompleteCurveSequence
                : accumulator.nextStrokeSequence;

        return {
            ...accumulator,
            sourceRecords: records,
            activeSourceKey: key,
            previousRawMetrics: incoming,
            lastCompleteDisplayCurve: displayCurve,
            lastCompleteCurveSequence: currentCurveSequence,
            nextStrokeSequence: accumulator.nextStrokeSequence + 1,
        };
    }

    private static addV2SessionStroke(
        accumulator: SessionAccumulator,
        incoming: IRawCalculatedMetrics,
        sourceEpoch: number,
        sourceStrokeId: number,
        key: string,
        records: Map<string, SessionStrokeRecord>,
    ): SessionAccumulator {
        const strokeDelta: number = SessionManagerService.rawStrokeCounterDelta(
            accumulator.previousRawMetrics,
            incoming,
        );
        if (strokeDelta === 0) {
            return accumulator;
        }
        const distanceDelta: number | undefined = SessionManagerService.keyedDistanceDelta(
            accumulator.previousRawMetrics,
            incoming,
        );
        if (distanceDelta === undefined) {
            return accumulator;
        }

        const distance: number = accumulator.sessionMetrics.distance + distanceDelta;
        const strokeCount: number = accumulator.sessionMetrics.strokeCount + strokeDelta;
        const workContribution: number = SessionManagerService.v2WorkContribution(incoming);
        const totalWork: number = accumulator.sessionMetrics.totalWork + workContribution;
        const rowMetrics: ISessionCalculatedMetrics = SessionManagerService.toSessionRowMetrics(
            incoming,
            distance,
            strokeCount,
            totalWork,
        );
        const record: SessionStrokeRecord = {
            sourceEpoch,
            sourceStrokeId,
            metrics: incoming,
            rowMetrics,
            isSessionStroke: true,
            workContribution,
            sequence: accumulator.nextStrokeSequence,
        };
        SessionManagerService.setBoundedRecord(records, key, record);
        const newCompleteCurve: IDisplayForceCurve | undefined =
            SessionManagerService.displayCurveFromMetrics(incoming);
        const lastCompleteDisplayCurve: IDisplayForceCurve | undefined =
            newCompleteCurve === undefined ? accumulator.lastCompleteDisplayCurve : newCompleteCurve;
        const lastCompleteCurveSequence: number =
            newCompleteCurve === undefined
                ? accumulator.lastCompleteCurveSequence
                : accumulator.nextStrokeSequence;
        const activeSessionMetrics: ISessionCalculatedMetrics = {
            ...rowMetrics,
            displayForceCurve: lastCompleteDisplayCurve,
        };

        return {
            ...accumulator,
            sessionMetrics: activeSessionMetrics,
            previousRawMetrics: incoming,
            sourceRecords: records,
            activeSourceKey: key,
            lastCompleteDisplayCurve,
            lastCompleteCurveSequence,
            nextStrokeSequence: accumulator.nextStrokeSequence + 1,
            hasInitialLegacyBaseline: false,
            v2RowUpdate: { metrics: rowMetrics, sourceEpoch, sourceStrokeId },
        };
    }

    private static keyedDistanceDelta(
        previousMetrics: IRawCalculatedMetrics,
        currentMetrics: IRawCalculatedMetrics,
    ): number | undefined {
        if (previousMetrics.sourceEpoch !== currentMetrics.sourceEpoch) {
            if (currentMetrics.rawDistance >= previousMetrics.rawDistance) {
                return currentMetrics.rawDistance - previousMetrics.rawDistance;
            }

            return SessionManagerService.currentStrokeDistanceCm(currentMetrics);
        }
        if (currentMetrics.rawDistance < previousMetrics.rawDistance) {
            console.error("Ignoring keyed metrics with regressing distance in the same source epoch", {
                previous: previousMetrics,
                current: currentMetrics,
            });

            return undefined;
        }
        const distanceDelta: number = currentMetrics.rawDistance - previousMetrics.rawDistance;
        if (!Number.isFinite(distanceDelta) || distanceDelta < 0) {
            console.error("Ignoring invalid keyed distance delta", {
                sourceEpoch: currentMetrics.sourceEpoch,
                sourceStrokeId: currentMetrics.sourceStrokeId,
                distanceDelta,
            });

            return undefined;
        }

        return distanceDelta;
    }

    private static setBoundedRecord(
        records: Map<string, SessionStrokeRecord>,
        key: string,
        record: SessionStrokeRecord,
    ): void {
        while (records.size >= MAX_SESSION_STROKE_RECORDS && !records.has(key)) {
            const oldestKey: string | undefined = records.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            records.delete(oldestKey);
        }
        records.set(key, record);
    }

    private static toSessionRowMetrics(
        metrics: IRawCalculatedMetrics,
        distance: number,
        strokeCount: number,
        totalWork: number,
    ): ISessionCalculatedMetrics {
        const {
            rawDistance: _rawDistance,
            rawStrokeCount: _rawStrokeCount,
            ...calculatedMetrics
        }: IRawCalculatedMetrics = metrics;

        return {
            ...calculatedMetrics,
            distance,
            strokeCount,
            totalWork,
            isDriveLengthAnomalous:
                metrics.forceCurve === undefined
                    ? metrics.isDriveLengthAnomalous
                    : metrics.forceCurve.driveLength > DRIVE_LENGTH_ANOMALY_THRESHOLD_METERS,
        };
    }

    private static displayCurveFromMetrics(metrics: IRawCalculatedMetrics): IDisplayForceCurve | undefined {
        if (metrics.forceCurveStatus !== "complete" || metrics.forceCurve === undefined) {
            return undefined;
        }

        return {
            ...metrics.forceCurve,
            samples: metrics.forceCurve.samples.map(
                (sample: IForceCurve["samples"][number]): IForceCurve["samples"][number] => ({
                    ...sample,
                }),
            ),
            isDriveLengthAnomalous: metrics.forceCurve.driveLength > DRIVE_LENGTH_ANOMALY_THRESHOLD_METERS,
        };
    }

    private static mergeV2Metrics(
        existing: IRawCalculatedMetrics,
        incoming: IRawCalculatedMetrics,
    ): IRawCalculatedMetrics {
        const isCurveSticky: boolean = existing.forceCurveStatus === "complete";
        const isRecoverySticky: boolean = existing.isExtendedMetricsPending === false;
        const isConflictingCompleteCurve: boolean =
            isCurveSticky &&
            incoming.forceCurveStatus === "complete" &&
            !SessionManagerService.forceCurvesEqual(existing.forceCurve, incoming.forceCurve);
        const isConflictingCompleteRecovery: boolean =
            isRecoverySticky &&
            incoming.isExtendedMetricsPending === false &&
            (existing.avgStrokePower !== incoming.avgStrokePower ||
                existing.recoveryDuration !== incoming.recoveryDuration ||
                existing.dragFactor !== incoming.dragFactor);

        if (isConflictingCompleteCurve || isConflictingCompleteRecovery) {
            console.error("Ignoring conflicting complete V2 stroke supplement", {
                sourceEpoch: incoming.sourceEpoch,
                sourceStrokeId: incoming.sourceStrokeId,
            });
        }

        const shouldKeepCurve: boolean = isCurveSticky && incoming.forceCurveStatus !== "complete";
        const shouldKeepRecovery: boolean = isRecoverySticky && incoming.isExtendedMetricsPending !== false;

        return {
            ...existing,
            ...incoming,
            ...(shouldKeepCurve || isConflictingCompleteCurve
                ? {
                      forceCurve: existing.forceCurve,
                      forceCurveStatus: existing.forceCurveStatus,
                      forceCurveStrokeId: existing.forceCurveStrokeId,
                      handleForces: existing.handleForces,
                      peakForce: existing.peakForce,
                      peakForcePositionNorm: existing.peakForcePositionNorm,
                      driveLength: existing.driveLength,
                      isDriveLengthAnomalous: existing.isDriveLengthAnomalous,
                  }
                : {}),
            ...(shouldKeepRecovery || isConflictingCompleteRecovery
                ? {
                      avgStrokePower: existing.avgStrokePower,
                      driveDuration: existing.driveDuration,
                      recoveryDuration: existing.recoveryDuration,
                      dragFactor: existing.dragFactor,
                      isExtendedMetricsPending: existing.isExtendedMetricsPending,
                  }
                : {}),
        };
    }

    private static rawMetricsEqual(left: IRawCalculatedMetrics, right: IRawCalculatedMetrics): boolean {
        const keys: Array<keyof IRawCalculatedMetrics> = [
            "avgStrokePower",
            "driveDuration",
            "recoveryDuration",
            "dragFactor",
            "rawDistance",
            "rawStrokeCount",
            "peakForce",
            "peakForcePositionNorm",
            "strokeRate",
            "speed",
            "distPerStroke",
            "driveLength",
            "powerBalance",
            "sourceEpoch",
            "sourceStrokeId",
            "forceCurveStatus",
            "forceCurveStrokeId",
            "isDriveLengthAnomalous",
            "isExtendedMetricsPending",
        ];

        return (
            keys.every((key: keyof IRawCalculatedMetrics): boolean => left[key] === right[key]) &&
            left.handleForces.length === right.handleForces.length &&
            left.handleForces.every(
                (force: number, index: number): boolean => force === right.handleForces[index],
            ) &&
            SessionManagerService.forceCurvesEqual(left.forceCurve, right.forceCurve) &&
            SessionManagerService.displayCurvesEqual(left.displayForceCurve, right.displayForceCurve)
        );
    }

    private static forceCurvesEqual(left?: IForceCurve, right?: IForceCurve): boolean {
        if (left === undefined || right === undefined) {
            return left === right;
        }

        return (
            left.strokeId === right.strokeId &&
            left.driveLength === right.driveLength &&
            left.driveDurationUs === right.driveDurationUs &&
            left.samples.length === right.samples.length &&
            left.samples.every(
                (sample: IForceCurve["samples"][number], index: number): boolean =>
                    sample.distance === right.samples[index].distance &&
                    sample.elapsedTimeUs === right.samples[index].elapsedTimeUs &&
                    sample.force === right.samples[index].force,
            )
        );
    }

    private static displayCurvesEqual(left?: IDisplayForceCurve, right?: IDisplayForceCurve): boolean {
        return (
            left?.isDriveLengthAnomalous === right?.isDriveLengthAnomalous &&
            SessionManagerService.forceCurvesEqual(left, right)
        );
    }

    private static hasV2Identity(metrics: IRawCalculatedMetrics): boolean {
        return (
            Number.isInteger(metrics.sourceEpoch) &&
            metrics.sourceEpoch! >= 0 &&
            Number.isInteger(metrics.sourceStrokeId) &&
            metrics.sourceStrokeId! >= 0 &&
            metrics.sourceStrokeId! < UINT16_RANGE
        );
    }

    private static hasValidV2Metrics(metrics: IRawCalculatedMetrics): boolean {
        const numericFields: Array<number> = [
            metrics.avgStrokePower,
            metrics.driveDuration,
            metrics.recoveryDuration,
            metrics.dragFactor,
            metrics.rawDistance,
            metrics.peakForce,
            metrics.peakForcePositionNorm,
            metrics.strokeRate,
            metrics.speed,
            metrics.distPerStroke,
            metrics.driveLength,
            metrics.powerBalance,
        ];

        return (
            SessionManagerService.hasV2Identity(metrics) &&
            SessionManagerService.hasValidRawCounters(metrics) &&
            numericFields.every(Number.isFinite) &&
            metrics.rawDistance >= 0 &&
            metrics.driveDuration >= 0 &&
            metrics.recoveryDuration >= 0 &&
            metrics.dragFactor >= 0 &&
            metrics.peakForcePositionNorm >= 0 &&
            metrics.distPerStroke >= 0 &&
            (metrics.isExtendedMetricsPending === undefined ||
                typeof metrics.isExtendedMetricsPending === "boolean")
        );
    }

    private static hasValidRawCounters(metrics: IRawCalculatedMetrics): boolean {
        return (
            Number.isInteger(metrics.rawStrokeCount) &&
            metrics.rawStrokeCount >= 0 &&
            metrics.rawStrokeCount < UINT16_RANGE &&
            Number.isFinite(metrics.rawDistance) &&
            metrics.rawDistance >= 0
        );
    }

    private static v2WorkContribution(metrics: IRawCalculatedMetrics): number {
        if (metrics.isExtendedMetricsPending !== false) {
            return 0;
        }
        if (
            !Number.isFinite(metrics.avgStrokePower) ||
            metrics.avgStrokePower < 0 ||
            !Number.isFinite(metrics.driveDuration) ||
            metrics.driveDuration < 0 ||
            !Number.isFinite(metrics.recoveryDuration) ||
            metrics.recoveryDuration < 0
        ) {
            console.error("Ignoring invalid completed V2 work metrics", metrics);

            return 0;
        }

        return metrics.avgStrokePower * (metrics.driveDuration + metrics.recoveryDuration);
    }

    private static legacyWorkContribution(metrics: IRawCalculatedMetrics): number {
        if (
            !Number.isFinite(metrics.avgStrokePower) ||
            metrics.avgStrokePower < 0 ||
            !Number.isFinite(metrics.driveDuration) ||
            metrics.driveDuration < 0 ||
            !Number.isFinite(metrics.recoveryDuration) ||
            metrics.recoveryDuration < 0
        ) {
            console.error("Ignoring invalid legacy work metrics", metrics);

            return 0;
        }

        return metrics.avgStrokePower * (metrics.driveDuration + metrics.recoveryDuration);
    }

    private static currentStrokeDistanceCm(metrics: IRawCalculatedMetrics): number {
        if (Number.isFinite(metrics.distPerStroke) && metrics.distPerStroke > 0) {
            return metrics.distPerStroke * 100;
        }
        if (metrics.rawStrokeCount === 1 && Number.isFinite(metrics.rawDistance)) {
            return metrics.rawDistance;
        }

        return 0;
    }

    private static sourceKey(sourceEpoch: number, sourceStrokeId: number): string {
        return `${sourceEpoch}:${sourceStrokeId}`;
    }

    private static isNewStrokeObservation(
        previous: IRawCalculatedMetrics,
        current: IRawCalculatedMetrics,
    ): boolean {
        // legacy reconnects have no epoch; both counters regressing is the reset
        // evidence already used by accumulation. A lone backward ID is stale.
        const isLegacyReset =
            current.sourceEpoch === undefined &&
            previous.sourceEpoch === undefined &&
            SessionManagerService.hasValidRawCounters(current) &&
            current.rawStrokeCount > 0 &&
            current.rawStrokeCount < previous.rawStrokeCount &&
            current.rawDistance < previous.rawDistance;

        return isLegacyReset || SessionManagerService.rawStrokeCounterAdvanced(previous, current);
    }

    private static rawStrokeCounterAdvanced(
        previous: IRawCalculatedMetrics,
        current: IRawCalculatedMetrics,
    ): boolean {
        return SessionManagerService.rawStrokeCounterDelta(previous, current) > 0;
    }

    private static rawStrokeCounterDelta(
        previous: IRawCalculatedMetrics,
        current: IRawCalculatedMetrics,
    ): number {
        if (current.rawStrokeCount > previous.rawStrokeCount) {
            return current.rawStrokeCount - previous.rawStrokeCount;
        }
        if (
            previous.rawStrokeCount >= UINT16_HALF_RANGE &&
            current.rawStrokeCount < UINT16_HALF_RANGE &&
            current.rawStrokeCount < previous.rawStrokeCount &&
            current.rawDistance >= previous.rawDistance
        ) {
            return current.rawStrokeCount + UINT16_RANGE - previous.rawStrokeCount;
        }

        return 0;
    }

    private static seedImmediatelyBeforeStroke(
        previous: IRawCalculatedMetrics,
        current: IRawCalculatedMetrics,
    ): IRawCalculatedMetrics {
        const isCounterReset: boolean = current.rawStrokeCount < previous.rawStrokeCount;
        const isEpochChanged: boolean =
            current.sourceEpoch !== undefined &&
            previous.sourceEpoch !== undefined &&
            current.sourceEpoch !== previous.sourceEpoch;
        const isFirstObservedMetrics: boolean =
            previous.rawStrokeCount === 0 && previous.rawDistance === 0 && current.rawStrokeCount > 1;
        if (!isCounterReset && !isEpochChanged && !isFirstObservedMetrics) {
            return previous;
        }

        let strokeDistance: number = SessionManagerService.currentStrokeDistanceCm(current);
        if (strokeDistance === 0 && current.rawStrokeCount === 1) {
            strokeDistance = current.rawDistance;
        }
        const seededRawDistance: number = current.rawDistance - strokeDistance;
        if (seededRawDistance < 0) {
            console.warn("Auto-start stroke distance exceeds the raw distance baseline", {
                rawDistance: current.rawDistance,
                strokeDistance,
            });
        }
        const seed: IRawCalculatedMetrics = {
            ...current,
            rawStrokeCount: (current.rawStrokeCount - 1 + UINT16_RANGE) % UINT16_RANGE,
            rawDistance: seededRawDistance < 0 ? 0 : seededRawDistance,
        };
        if (SessionManagerService.hasV2Identity(current)) {
            seed.sourceEpoch = current.sourceEpoch;
            seed.sourceStrokeId = (current.sourceStrokeId! - 1 + UINT16_RANGE) % UINT16_RANGE;
            seed.forceCurve = undefined;
            seed.forceCurveStatus = "pending";
            seed.forceCurveStrokeId = seed.sourceStrokeId;
            seed.isExtendedMetricsPending = true;
            seed.avgStrokePower = 0;
            seed.recoveryDuration = 0;
            seed.dragFactor = 0;
        }

        return seed;
    }

    private static areSessionMetricsEqual(
        previous: ISessionCalculatedMetrics,
        current: ISessionCalculatedMetrics,
    ): boolean {
        const scalarKeys: Array<keyof ISessionCalculatedMetrics> = [
            "avgStrokePower",
            "driveDuration",
            "recoveryDuration",
            "dragFactor",
            "distance",
            "strokeCount",
            "speed",
            "strokeRate",
            "peakForce",
            "peakForcePositionNorm",
            "distPerStroke",
            "driveLength",
            "totalWork",
            "powerBalance",
            "sourceEpoch",
            "sourceStrokeId",
            "forceCurveStatus",
            "forceCurveStrokeId",
            "isDriveLengthAnomalous",
            "isExtendedMetricsPending",
        ];

        return (
            scalarKeys.every(
                (key: keyof ISessionCalculatedMetrics): boolean => previous[key] === current[key],
            ) &&
            previous.handleForces.length === current.handleForces.length &&
            previous.handleForces.every(
                (force: number, index: number): boolean => force === current.handleForces[index],
            ) &&
            SessionManagerService.forceCurvesEqual(previous.forceCurve, current.forceCurve) &&
            SessionManagerService.displayCurvesEqual(previous.displayForceCurve, current.displayForceCurve)
        );
    }
}
