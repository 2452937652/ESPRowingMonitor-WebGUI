import {
    ForceCurveStatus,
    IBaseMetrics,
    IExtendedMetrics,
    IForceCurve,
    IForceCurvePoint,
    IRawCalculatedMetrics,
} from "../common.interfaces";

/**
 * A raw device stroke is allowed to acquire its base metrics, force curve, and
 * extended metrics independently.  The key is deliberately the device stroke
 * id plus an epoch: a device reboot can reuse stroke number 1 without merging
 * it into data from the previous connection.
 */
export interface IStrokeMetricUpdate {
    sourceEpoch: number;
    sourceStrokeId: number;
    /** True for a base-metric packet (including a stopped/coasting repeat). */
    isBaseMetric: boolean;
    /** False when a delayed curve/metric belongs to an earlier completed stroke. */
    isCurrentStroke: boolean;
    metrics: IRawCalculatedMetrics;
}

interface StrokeRecord {
    base?: IBaseMetrics;
    previousBase?: IBaseMetrics;
    extended?: IExtendedMetrics;
    legacyForces?: Array<number>;
    physicalCurve?: IForceCurve;
}

export const DRIVE_LENGTH_ANOMALY_THRESHOLD_METERS = 5;

const MAX_CACHED_STROKES = 64;
const EMPTY_EXTENDED_METRICS: IExtendedMetrics = {
    avgStrokePower: 0,
    driveDuration: 0,
    recoveryDuration: 0,
    dragFactor: 0,
};

/**
 * Stateful but framework-free coordinator used by MetricsService.  Keeping it
 * separate from RxJS makes the association rules testable while the service
 * remains responsible for reconnecting BLE streams.
 */
export class StrokeMetricsAssembler {
    private readonly records = new Map<number, StrokeRecord>();
    private currentStrokeId: number | undefined;
    private lastBase: IBaseMetrics | undefined;
    private epoch = 0;
    private physicalCurveSupported = false;
    /** A reconnect can still deliver stale queued notifications. Wait for a fresh base packet first. */
    private awaitingFreshBaseAfterReset = false;

    constructor(private readonly calculateLegacyDriveLength: (sampleCount: number) => number) {}

    acceptBaseMetrics(base: IBaseMetrics): IStrokeMetricUpdate | undefined {
        if (this.lastBase !== undefined && base.strokeCount < this.lastBase.strokeCount) {
            // The base packet that exposed the reboot is itself a trustworthy
            // beginning of the next epoch.
            this.reset(false);
        }

        this.awaitingFreshBaseAfterReset = false;
        const record = this.recordFor(base.strokeCount);
        const isNewStroke = record.base === undefined || record.base.strokeCount !== base.strokeCount;
        record.previousBase = this.lastBase;
        this.lastBase = base;
        if (isNewStroke) {
            this.currentStrokeId = base.strokeCount;
            this.pruneRecords();
        }
        record.base = base;

        return this.toUpdate(base.strokeCount, true);
    }

    acceptExtendedMetrics(
        metrics: IExtendedMetrics,
        strokeId: number | undefined,
    ): IStrokeMetricUpdate | undefined {
        if (this.awaitingFreshBaseAfterReset) {
            return undefined;
        }

        // A V1 extended packet has no stroke identity. It remains supported for
        // old firmware only; once V2 physical curves are available, attaching a
        // late V1 packet to the latest stroke would be unsafe.
        if (strokeId === undefined && this.physicalCurveSupported) {
            return undefined;
        }
        const targetStrokeId = strokeId ?? this.currentStrokeId;
        if (targetStrokeId === undefined) {
            return undefined;
        }

        this.recordFor(targetStrokeId).extended = metrics;

        return this.toUpdate(targetStrokeId, false);
    }

    acceptLegacyForces(forces: Array<number>): IStrokeMetricUpdate | undefined {
        if (this.physicalCurveSupported || this.currentStrokeId === undefined) {
            return undefined;
        }

        const record = this.recordFor(this.currentStrokeId);
        // Legacy force arrays have no owning stroke id. Once a non-empty array
        // has been associated with the current stroke, a later legacy array
        // cannot safely be reinterpreted as a correction. V2 physical curves
        // remain the keyed, replaceable update path.
        if (record.legacyForces !== undefined && record.legacyForces.length > 0) {
            return undefined;
        }
        record.legacyForces = [...forces];

        return this.toUpdate(this.currentStrokeId, false);
    }

    acceptPhysicalCurve(curve: IForceCurve): IStrokeMetricUpdate | undefined {
        this.acceptPhysicalCurveSupport(true);
        if (this.awaitingFreshBaseAfterReset) {
            return undefined;
        }
        this.recordFor(curve.strokeId).physicalCurve = curve;

        return this.toUpdate(curve.strokeId, false);
    }

    acceptPhysicalCurveSupport(supported: boolean): IStrokeMetricUpdate | undefined {
        // A connected V2 characteristic is authoritative. Do not fall back to
        // unkeyed V1 arrays halfway through a connection merely because one
        // force-curve notification is delayed.
        if (!supported && this.physicalCurveSupported) {
            return undefined;
        }
        if (supported === this.physicalCurveSupported) {
            return undefined;
        }

        this.physicalCurveSupported = supported;
        if (supported) {
            for (const record of this.records.values()) {
                record.legacyForces = undefined;
            }
        }

        return this.currentStrokeId === undefined ? undefined : this.toUpdate(this.currentStrokeId, false);
    }

    reset(awaitFreshBase: boolean = true): void {
        this.records.clear();
        this.currentStrokeId = undefined;
        this.lastBase = undefined;
        this.physicalCurveSupported = false;
        this.awaitingFreshBaseAfterReset = awaitFreshBase;
        this.epoch++;
    }

    private recordFor(strokeId: number): StrokeRecord {
        const existing = this.records.get(strokeId);
        if (existing !== undefined) {
            return existing;
        }

        const record: StrokeRecord = {};
        this.records.set(strokeId, record);

        return record;
    }

    private toUpdate(strokeId: number, isBaseMetric: boolean): IStrokeMetricUpdate | undefined {
        const record = this.records.get(strokeId);
        if (record?.base === undefined) {
            // Curves and V2 extended metrics may precede their base packet.
            // Keep them pending rather than fabricating a zero-length stroke.
            return undefined;
        }

        return {
            sourceEpoch: this.epoch,
            sourceStrokeId: strokeId,
            isBaseMetric,
            isCurrentStroke: this.currentStrokeId === strokeId,
            metrics: this.buildMetrics(strokeId, record),
        };
    }

    private buildMetrics(strokeId: number, record: StrokeRecord): IRawCalculatedMetrics {
        const base = record.base!;
        const extended = record.extended ?? EMPTY_EXTENDED_METRICS;
        const physicalCurve = record.physicalCurve;
        const legacyForces = record.legacyForces ?? [];
        const forceCurve: Array<IForceCurvePoint> | undefined = physicalCurve?.samples;
        const handleForces = physicalCurve?.samples.map(({ force }: IForceCurvePoint): number => force) ?? legacyForces;
        const driveLength =
            physicalCurve?.driveLength ?? this.calculateLegacyDriveLength(record.legacyForces?.length ?? 0);
        const forceCurveStatus: ForceCurveStatus =
            physicalCurve !== undefined
                ? "complete"
                : this.physicalCurveSupported
                  ? "pending"
                  : legacyForces.length > 0
                    ? "legacy"
                    : "unavailable";
        const { peakForce, peakForceIndex } = handleForces.reduce(
            (
                accumulator: { peakForce: number; peakForceIndex: number },
                force: number,
                index: number,
            ): { peakForce: number; peakForceIndex: number } =>
                force > accumulator.peakForce ? { peakForce: force, peakForceIndex: index } : accumulator,
            { peakForce: 0, peakForceIndex: 0 },
        );
        const isDriveLengthAnomalous = driveLength > DRIVE_LENGTH_ANOMALY_THRESHOLD_METERS;
        // Base metrics often arrive before the stroke-keyed extended packet.
        // Until then, zero power/time values are unknown, not measured zeros.
        // Legacy packets have no completion flag, so only their absence is pending.
        const isExtendedMetricsPending = record.extended === undefined || extended.recoveryMetricsComplete === false;

        return {
            avgStrokePower: extended.avgStrokePower,
            driveDuration: physicalCurve?.driveDuration ?? extended.driveDuration / 1e6,
            recoveryDuration: extended.recoveryDuration / 1e6,
            dragFactor: extended.dragFactor,
            rawDistance: base.distance,
            rawStrokeCount: base.strokeCount,
            handleForces,
            forceCurve,
            forceCurveStrokeId: physicalCurve === undefined ? undefined : strokeId,
            forceCurveStatus,
            isDriveLengthAnomalous,
            isExtendedMetricsPending,
            peakForce,
            peakForcePositionNorm:
                physicalCurve !== undefined && driveLength > 0
                    ? ((physicalCurve.samples[peakForceIndex]?.distance ?? 0) / driveLength) * 100
                    : handleForces.length > 1
                      ? (peakForceIndex / (handleForces.length - 1)) * 100
                      : 0,
            strokeRate: this.calculateStrokeRate(record.previousBase, base),
            speed: this.calculateSpeed(record.previousBase, base),
            distPerStroke: this.calculateStrokeDistance(record.previousBase, base),
            driveLength,
            powerBalance: 0.5,
        };
    }

    private calculateSpeed(previous: IBaseMetrics | undefined, current: IBaseMetrics): number {
        if (
            previous === undefined ||
            current.distance === previous.distance ||
            current.revTime === previous.revTime
        ) {
            return 0;
        }

        return (current.distance - previous.distance) / 100 / ((current.revTime - previous.revTime) / 1e6);
    }

    private calculateStrokeDistance(previous: IBaseMetrics | undefined, current: IBaseMetrics): number {
        if (
            previous === undefined ||
            current.distance === previous.distance ||
            current.strokeCount === previous.strokeCount
        ) {
            return 0;
        }

        return (current.distance - previous.distance) / 100 / (current.strokeCount - previous.strokeCount);
    }

    private calculateStrokeRate(previous: IBaseMetrics | undefined, current: IBaseMetrics): number {
        if (
            previous === undefined ||
            current.strokeCount === previous.strokeCount ||
            current.strokeTime === previous.strokeTime
        ) {
            return 0;
        }

        return ((current.strokeCount - previous.strokeCount) / ((current.strokeTime - previous.strokeTime) / 1e6)) * 60;
    }

    private pruneRecords(): void {
        if (this.records.size <= MAX_CACHED_STROKES) {
            return;
        }

        const oldestStrokeId = this.records.keys().next().value;
        if (oldestStrokeId !== undefined && oldestStrokeId !== this.currentStrokeId) {
            this.records.delete(oldestStrokeId);
        }
    }
}
