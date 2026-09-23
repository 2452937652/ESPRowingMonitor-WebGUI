import { IBaseMetrics } from "../common.interfaces";

import { ICompletedStrokeMetricsV2 } from "./ergometer/completed-stroke-v2-decoder";
import { IPhysicalForceCurveV2 } from "./ergometer/physical-force-curve-v2-decoder";

const UINT16_RANGE = 0x10000;
const UINT16_HALF_RANGE = UINT16_RANGE / 2;
const MAX_DRIVE_DURATION_US = 60_000_000;
const MAX_RECOVERY_DURATION_US = 3_600_000_000;
const MAX_AVG_STROKE_POWER_W = 10_000;
const MAX_DRAG_FACTOR = 1_000;
const MAX_SAMPLE_COUNT = 128;
const MAX_CACHED_STROKES = 16;

export interface IAssembledStrokeMetrics {
    sourceEpoch: number;
    sourceStrokeId: number;
    previousBase: IBaseMetrics;
    base: IBaseMetrics;
    physicalCurve?: IPhysicalForceCurveV2;
    completedMetrics?: ICompletedStrokeMetricsV2;
}

export interface IStrokeMetricsAssemblerUpdate {
    accepted: boolean;
    sourceEpoch: number;
    sourceStrokeId?: number;
    assembly?: IAssembledStrokeMetrics;
}

interface IStrokeRecord {
    sourceEpoch: number;
    sourceStrokeId: number;
    base?: IBaseMetrics;
    previousBase?: IBaseMetrics;
    physicalCurve?: IPhysicalForceCurveV2;
    completedMetrics?: ICompletedStrokeMetricsV2;
}

/** Associates V2 packets by their raw 16 bit stroke ID within one connection epoch. */
export class StrokeMetricsAssembler {
    private readonly records: Map<string, IStrokeRecord> = new Map<string, IStrokeRecord>();
    private sourceEpochValue: number = 0;
    private lastBase: IBaseMetrics | undefined;
    private currentStrokeIdValue: number | undefined;

    get sourceEpoch(): number {
        return this.sourceEpochValue;
    }

    get currentStrokeId(): number | undefined {
        return this.currentStrokeIdValue;
    }

    resetSourceEpoch(): number {
        this.sourceEpochValue++;
        this.records.clear();
        this.lastBase = undefined;
        this.currentStrokeIdValue = undefined;

        return this.sourceEpochValue;
    }

    acceptBaseMetrics(base: IBaseMetrics): IStrokeMetricsAssemblerUpdate {
        if (!this.isValidBase(base)) {
            console.error("Ignoring non-finite or invalid base metrics", base);

            return this.update(false);
        }

        if (this.lastBase !== undefined) {
            const previousBase: IBaseMetrics = this.lastBase;
            const strokeCountDelta: number = this.forwardStrokeCountDelta(
                base.strokeCount,
                previousBase.strokeCount,
            );
            if (this.isNaturalStrokeIdWrap(previousBase, base, strokeCountDelta)) {
                this.advanceEpochAtStrokeIdWrap(base.strokeCount);
            } else if (this.isCredibleBaseReset(previousBase, base, strokeCountDelta)) {
                console.warn("Detected a Base counter reset; advancing the source epoch", {
                    previous: previousBase,
                    current: base,
                });
                this.resetSourceEpoch();
            }
        }

        if (this.lastBase !== undefined) {
            const strokeCountDelta: number = this.forwardStrokeCountDelta(
                base.strokeCount,
                this.lastBase.strokeCount,
            );
            if (
                base.revTime < this.lastBase.revTime ||
                base.distance < this.lastBase.distance ||
                base.strokeTime < this.lastBase.strokeTime ||
                strokeCountDelta > UINT16_HALF_RANGE
            ) {
                console.error("Ignoring non-monotonic base metrics within the current source epoch", {
                    previous: this.lastBase,
                    current: base,
                });

                return this.update(false);
            }

            if (this.baseMetricsEqual(base, this.lastBase)) {
                return this.update(false, base.strokeCount);
            }
        }

        const previousBase: IBaseMetrics = this.lastBase ?? base;
        const sourceStrokeId: number = base.strokeCount;
        const record: IStrokeRecord = this.recordFor(sourceStrokeId);
        record.previousBase = { ...previousBase };
        record.base = { ...base };
        this.lastBase = { ...base };
        this.currentStrokeIdValue = sourceStrokeId;
        this.pruneRecords(sourceStrokeId);

        return this.update(true, sourceStrokeId, this.assemble(record));
    }

    acceptPhysicalCurve(curve: IPhysicalForceCurveV2): IStrokeMetricsAssemblerUpdate {
        if (!this.isValidPhysicalCurve(curve)) {
            console.error("Ignoring invalid Physical Force Curve V2 data", curve);

            return this.update(false, curve.strokeId);
        }

        if (!this.isWithinCacheWindow(curve.strokeId)) {
            console.error("Ignoring Physical Force Curve V2 data outside the active stroke window", curve);

            return this.update(false, curve.strokeId);
        }

        const record: IStrokeRecord = this.recordFor(curve.strokeId);
        if (
            record.completedMetrics !== undefined &&
            record.completedMetrics.driveDurationUs !== curve.driveDurationUs
        ) {
            console.error("V2 stroke metric durations disagree for stroke", curve.strokeId);

            return this.update(false, curve.strokeId);
        }
        if (record.physicalCurve !== undefined) {
            if (this.physicalCurvesEqual(record.physicalCurve, curve)) {
                return this.update(false, curve.strokeId);
            }

            console.error("Ignoring conflicting Physical Force Curve V2 data for stroke", curve.strokeId);

            return this.update(false, curve.strokeId);
        }

        record.physicalCurve = this.copyPhysicalCurve(curve);

        return this.update(true, curve.strokeId, this.assemble(record));
    }

    acceptCompletedMetrics(metrics: ICompletedStrokeMetricsV2): IStrokeMetricsAssemblerUpdate {
        if (!this.isValidCompletedMetrics(metrics)) {
            console.error("Ignoring invalid Completed Stroke Metrics V2 data", metrics);

            return this.update(false, metrics.strokeId);
        }

        if (!this.isWithinCacheWindow(metrics.strokeId)) {
            console.error(
                "Ignoring Completed Stroke Metrics V2 data outside the active stroke window",
                metrics,
            );

            return this.update(false, metrics.strokeId);
        }

        const record: IStrokeRecord = this.recordFor(metrics.strokeId);
        if (
            record.physicalCurve !== undefined &&
            record.physicalCurve.driveDurationUs !== metrics.driveDurationUs
        ) {
            console.error("V2 stroke metric durations disagree for stroke", metrics.strokeId);

            return this.update(false, metrics.strokeId);
        }
        const existing: ICompletedStrokeMetricsV2 | undefined = record.completedMetrics;
        if (existing !== undefined) {
            if (existing.recovery.status === "complete") {
                if (metrics.recovery.status === "pending") {
                    return this.update(false, metrics.strokeId);
                }
                if (this.completedMetricsEqual(existing, metrics)) {
                    return this.update(false, metrics.strokeId);
                }

                console.error("Ignoring conflicting completed stroke metrics for stroke", metrics.strokeId);

                return this.update(false, metrics.strokeId);
            }

            if (this.completedMetricsEqual(existing, metrics)) {
                return this.update(false, metrics.strokeId);
            }
        }

        record.completedMetrics = this.copyCompletedMetrics(metrics);
        const assembly: IAssembledStrokeMetrics | undefined = this.assemble(record);
        if (
            assembly !== undefined &&
            record.physicalCurve !== undefined &&
            record.physicalCurve.driveDurationUs !== metrics.driveDurationUs
        ) {
            console.error("V2 stroke metric durations disagree for stroke", metrics.strokeId);
        }

        return this.update(true, metrics.strokeId, assembly);
    }

    private update(
        accepted: boolean,
        sourceStrokeId?: number,
        assembly?: IAssembledStrokeMetrics,
    ): IStrokeMetricsAssemblerUpdate {
        return {
            accepted,
            sourceEpoch: this.sourceEpochValue,
            sourceStrokeId,
            assembly,
        };
    }

    private recordFor(sourceStrokeId: number): IStrokeRecord {
        const key: string = this.recordKey(sourceStrokeId);
        const existing: IStrokeRecord | undefined = this.records.get(key);
        if (existing !== undefined) {
            return existing;
        }

        while (this.records.size >= MAX_CACHED_STROKES) {
            const oldestKey: string | undefined = this.records.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.records.delete(oldestKey);
        }

        const record: IStrokeRecord = { sourceEpoch: this.sourceEpochValue, sourceStrokeId };
        this.records.set(key, record);

        return record;
    }

    private recordKey(sourceStrokeId: number): string {
        return `${this.sourceEpochValue}:${sourceStrokeId}`;
    }

    private pruneRecords(currentStrokeId: number): void {
        for (const [key, record] of this.records.entries()) {
            const ahead: number = this.forwardStrokeCountDelta(record.sourceStrokeId, currentStrokeId);
            const behind: number = this.forwardStrokeCountDelta(currentStrokeId, record.sourceStrokeId);
            if (ahead > MAX_CACHED_STROKES && behind > MAX_CACHED_STROKES) {
                this.records.delete(key);
            }
        }
    }

    private isWithinCacheWindow(sourceStrokeId: number): boolean {
        if (this.currentStrokeIdValue === undefined) {
            return true;
        }

        const ahead: number = this.forwardStrokeCountDelta(sourceStrokeId, this.currentStrokeIdValue);
        const behind: number = this.forwardStrokeCountDelta(this.currentStrokeIdValue, sourceStrokeId);

        return ahead <= MAX_CACHED_STROKES || behind <= MAX_CACHED_STROKES;
    }

    private forwardStrokeCountDelta(current: number, previous: number): number {
        return (current - previous + UINT16_RANGE) % UINT16_RANGE;
    }

    private isValidBase(base: IBaseMetrics): boolean {
        return (
            Number.isInteger(base.strokeCount) &&
            base.strokeCount >= 0 &&
            base.strokeCount < UINT16_RANGE &&
            Number.isFinite(base.revTime) &&
            base.revTime >= 0 &&
            Number.isFinite(base.distance) &&
            base.distance >= 0 &&
            Number.isFinite(base.strokeTime) &&
            base.strokeTime >= 0
        );
    }

    private baseMetricsEqual(left: IBaseMetrics, right: IBaseMetrics): boolean {
        return (
            left.strokeCount === right.strokeCount &&
            left.revTime === right.revTime &&
            left.distance === right.distance &&
            left.strokeTime === right.strokeTime
        );
    }

    private isValidPhysicalCurve(curve: IPhysicalForceCurveV2): boolean {
        if (
            !Number.isInteger(curve.strokeId) ||
            curve.strokeId < 0 ||
            curve.strokeId >= UINT16_RANGE ||
            !Number.isFinite(curve.driveLength) ||
            curve.driveLength <= 0 ||
            !Number.isInteger(curve.driveDurationUs) ||
            curve.driveDurationUs <= 0 ||
            curve.driveDurationUs > MAX_DRIVE_DURATION_US ||
            !Array.isArray(curve.samples) ||
            curve.samples.length === 0 ||
            curve.samples.length > MAX_SAMPLE_COUNT
        ) {
            return false;
        }

        return this.arePhysicalCurveSamplesValid(curve);
    }

    private arePhysicalCurveSamplesValid(curve: IPhysicalForceCurveV2): boolean {
        let previousDistance = -1;
        let previousElapsedTimeUs = -1;
        for (const sample of curve.samples) {
            if (!this.isValidPhysicalCurveSample(sample, curve, previousDistance, previousElapsedTimeUs)) {
                return false;
            }

            previousDistance = sample.distance;
            previousElapsedTimeUs = sample.elapsedTimeUs;
        }

        return true;
    }

    private isValidPhysicalCurveSample(
        sample: IPhysicalForceCurveV2["samples"][number],
        curve: IPhysicalForceCurveV2,
        previousDistance: number,
        previousElapsedTimeUs: number,
    ): boolean {
        return (
            Number.isFinite(sample.distance) &&
            sample.distance >= 0 &&
            sample.distance <= curve.driveLength &&
            sample.distance >= previousDistance &&
            Number.isInteger(sample.elapsedTimeUs) &&
            sample.elapsedTimeUs >= 0 &&
            sample.elapsedTimeUs <= curve.driveDurationUs &&
            sample.elapsedTimeUs >= previousElapsedTimeUs &&
            Number.isFinite(sample.force)
        );
    }

    private isCredibleBaseReset(
        previous: IBaseMetrics,
        current: IBaseMetrics,
        strokeCountDelta: number,
    ): boolean {
        const decreasedCounters: number = [
            current.revTime < previous.revTime,
            current.distance < previous.distance,
            current.strokeTime < previous.strokeTime,
        ].filter(Boolean).length;

        return (
            decreasedCounters >= 2 &&
            (current.strokeCount < previous.strokeCount || strokeCountDelta > UINT16_HALF_RANGE)
        );
    }

    private isNaturalStrokeIdWrap(
        previous: IBaseMetrics,
        current: IBaseMetrics,
        strokeCountDelta: number,
    ): boolean {
        return (
            current.strokeCount < previous.strokeCount &&
            strokeCountDelta > 0 &&
            strokeCountDelta < UINT16_HALF_RANGE &&
            current.revTime >= previous.revTime &&
            current.distance >= previous.distance &&
            current.strokeTime >= previous.strokeTime
        );
    }

    private advanceEpochAtStrokeIdWrap(nextStrokeId: number): void {
        const pendingNextStroke: IStrokeRecord | undefined = this.records.get(this.recordKey(nextStrokeId));
        let carriedRecord: IStrokeRecord | undefined;
        if (
            pendingNextStroke !== undefined &&
            pendingNextStroke.base === undefined &&
            pendingNextStroke.previousBase === undefined
        ) {
            carriedRecord = {
                sourceEpoch: this.sourceEpochValue + 1,
                sourceStrokeId: nextStrokeId,
                physicalCurve:
                    pendingNextStroke.physicalCurve === undefined
                        ? undefined
                        : this.copyPhysicalCurve(pendingNextStroke.physicalCurve),
                completedMetrics:
                    pendingNextStroke.completedMetrics === undefined
                        ? undefined
                        : this.copyCompletedMetrics(pendingNextStroke.completedMetrics),
            };
        }
        const canCarryNextStroke: boolean = carriedRecord !== undefined;
        const discardedPendingCount: number = [...this.records.values()].filter(
            (record: IStrokeRecord): boolean =>
                record.base === undefined &&
                (record.physicalCurve !== undefined || record.completedMetrics !== undefined) &&
                !(canCarryNextStroke && record === pendingNextStroke),
        ).length;

        this.resetSourceEpoch();
        if (carriedRecord !== undefined) {
            this.records.set(this.recordKey(nextStrokeId), carriedRecord);
        }
        if (discardedPendingCount > 0) {
            console.warn(
                `Discarded ${discardedPendingCount} pre-Base V2 packet record(s) during stroke ID wrap`,
            );
        }
    }

    private isValidCompletedMetrics(metrics: ICompletedStrokeMetricsV2): boolean {
        if (
            !Number.isInteger(metrics.strokeId) ||
            metrics.strokeId < 0 ||
            metrics.strokeId >= UINT16_RANGE ||
            !Number.isInteger(metrics.driveDurationUs) ||
            metrics.driveDurationUs <= 0 ||
            metrics.driveDurationUs > MAX_DRIVE_DURATION_US
        ) {
            return false;
        }

        if (metrics.recovery.status === "pending") {
            return true;
        }

        return (
            metrics.recovery.status === "complete" &&
            Number.isInteger(metrics.recovery.durationUs) &&
            metrics.recovery.durationUs > 0 &&
            metrics.recovery.durationUs <= MAX_RECOVERY_DURATION_US &&
            Number.isFinite(metrics.recovery.avgStrokePowerW) &&
            metrics.recovery.avgStrokePowerW >= 0 &&
            metrics.recovery.avgStrokePowerW <= MAX_AVG_STROKE_POWER_W &&
            Number.isFinite(metrics.recovery.dragFactor) &&
            metrics.recovery.dragFactor >= 0 &&
            metrics.recovery.dragFactor <= MAX_DRAG_FACTOR
        );
    }

    private physicalCurvesEqual(left: IPhysicalForceCurveV2, right: IPhysicalForceCurveV2): boolean {
        return (
            left.strokeId === right.strokeId &&
            left.driveLength === right.driveLength &&
            left.driveDurationUs === right.driveDurationUs &&
            left.samples.length === right.samples.length &&
            left.samples.every(
                (sample: IPhysicalForceCurveV2["samples"][number], index: number): boolean =>
                    sample.distance === right.samples[index].distance &&
                    sample.elapsedTimeUs === right.samples[index].elapsedTimeUs &&
                    sample.force === right.samples[index].force,
            )
        );
    }

    private completedMetricsEqual(
        left: ICompletedStrokeMetricsV2,
        right: ICompletedStrokeMetricsV2,
    ): boolean {
        if (
            left.strokeId !== right.strokeId ||
            left.driveDurationUs !== right.driveDurationUs ||
            left.recovery.status !== right.recovery.status
        ) {
            return false;
        }

        if (left.recovery.status === "pending" || right.recovery.status === "pending") {
            return left.recovery.status === "pending" && right.recovery.status === "pending";
        }

        return (
            left.recovery.durationUs === right.recovery.durationUs &&
            left.recovery.avgStrokePowerW === right.recovery.avgStrokePowerW &&
            left.recovery.dragFactor === right.recovery.dragFactor
        );
    }

    private copyPhysicalCurve(curve: IPhysicalForceCurveV2): IPhysicalForceCurveV2 {
        return {
            ...curve,
            samples: curve.samples.map(
                (
                    sample: IPhysicalForceCurveV2["samples"][number],
                ): IPhysicalForceCurveV2["samples"][number] => ({
                    ...sample,
                }),
            ),
        };
    }

    private copyCompletedMetrics(metrics: ICompletedStrokeMetricsV2): ICompletedStrokeMetricsV2 {
        return {
            ...metrics,
            recovery: { ...metrics.recovery },
        };
    }

    private assemble(record: IStrokeRecord): IAssembledStrokeMetrics | undefined {
        const base: IBaseMetrics | undefined = record.base;
        const previousBase: IBaseMetrics | undefined = record.previousBase;
        const physicalCurve: IPhysicalForceCurveV2 | undefined = record.physicalCurve;
        const completedMetrics: ICompletedStrokeMetricsV2 | undefined = record.completedMetrics;
        if (base === undefined || previousBase === undefined) {
            return undefined;
        }

        if (
            base.strokeCount !== record.sourceStrokeId ||
            (physicalCurve !== undefined && physicalCurve.strokeId !== record.sourceStrokeId) ||
            (completedMetrics !== undefined && completedMetrics.strokeId !== record.sourceStrokeId)
        ) {
            console.error("Ignoring V2 metrics that do not match the base stroke ID", record.sourceStrokeId);

            return undefined;
        }

        if (
            physicalCurve !== undefined &&
            completedMetrics !== undefined &&
            physicalCurve.driveDurationUs !== completedMetrics.driveDurationUs
        ) {
            console.error("V2 stroke metric durations disagree for stroke", record.sourceStrokeId);

            return {
                sourceEpoch: record.sourceEpoch,
                sourceStrokeId: record.sourceStrokeId,
                previousBase: { ...previousBase },
                base: { ...base },
            };
        }

        return {
            sourceEpoch: record.sourceEpoch,
            sourceStrokeId: record.sourceStrokeId,
            previousBase: { ...previousBase },
            base: { ...base },
            physicalCurve: physicalCurve === undefined ? undefined : this.copyPhysicalCurve(physicalCurve),
            completedMetrics:
                completedMetrics === undefined ? undefined : this.copyCompletedMetrics(completedMetrics),
        };
    }
}
