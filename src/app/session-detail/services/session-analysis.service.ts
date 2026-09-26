import { Injectable } from "@angular/core";

import { IForceCurvePoint } from "../../../common/common.interfaces";
import {
    IExportHandleForces,
    IExportRecord,
    IExportSession,
    IHandleForcesEntity,
    ILapEntity,
    IMetricsEntity,
} from "../../../common/database.interfaces";
import { appDB } from "../../../common/utils/app-database";
import {
    computeBalanceMetrics,
    MIN_BALANCE_PAIRS_FOR_CONSISTENCY,
    strokesToBalanceInput,
} from "../../../common/utils/balance-metrics";
import { sessionStrokeRecords } from "../../../common/utils/session-stroke-records";
import {
    ISessionAnalysis,
    ISessionAverages,
    ISessionMaximums,
    ISessionRecord,
    ISessionStatistics,
    ISessionStroke,
} from "../models/session-analysis.interfaces";

import { buildLapsFromMarkers, detectLaps } from "./lap-detection";

const findPeakForce = (forces: Array<number>): { peakForce: number; peakForceIndex: number } =>
    forces.reduce(
        (
            accumulator: { peakForce: number; peakForceIndex: number },
            force: number,
            index: number,
        ): { peakForce: number; peakForceIndex: number } =>
            force > accumulator.peakForce ? { peakForce: force, peakForceIndex: index } : accumulator,
        { peakForce: 0, peakForceIndex: 0 },
    );

const buildLegacyForceCurve = (
    forces: Array<number>,
    driveLength: number,
): Array<IForceCurvePoint> | undefined => {
    if (!(driveLength > 0)) return undefined;
    const sampleDistance = forces.length > 1 && driveLength > 0 ? driveLength / (forces.length - 1) : 1;

    return forces.map((force: number, index: number): IForceCurvePoint => ({
        distance: sampleDistance * index,
        elapsedTimeUs: 0,
        force,
    }));
};

const calculatePeakPosition = (
    forceCurve: Array<IForceCurvePoint> | undefined,
    driveLength: number,
    peakForceIndex: number,
    forceCount: number,
): number =>
    forceCurve !== undefined && driveLength > 0
        ? ((forceCurve[peakForceIndex]?.distance ?? 0) / driveLength) * 100
        : forceCount > 1
          ? (peakForceIndex / (forceCount - 1)) * 100
          : 0;

@Injectable({
    providedIn: "root",
})
export class SessionAnalysisService {
    async loadSession(sessionId: number): Promise<ISessionAnalysis> {
        return appDB.transaction(
            "r",
            appDB.sessionData,
            appDB.handleForces,
            appDB.connectedDevice,
            appDB.laps,
            async (): Promise<ISessionAnalysis> => {
                const [metricsEntities, handleForcesEntities, connectedDevice, lapEntities]: [
                    Array<IMetricsEntity>,
                    Array<IHandleForcesEntity>,
                    { sessionId: number; deviceName: string } | undefined,
                    Array<ILapEntity>,
                ] = await Promise.all([
                    appDB.sessionData.where({ sessionId }).sortBy("timeStamp"),
                    appDB.handleForces.where({ sessionId }).toArray(),
                    appDB.connectedDevice.where({ sessionId }).last(),
                    appDB.laps.where({ sessionId }).sortBy("timeStamp"),
                ]);

                const handleForcesMap = this.buildHandleForcesMap(handleForcesEntities);
                const canonical = sessionStrokeRecords(metricsEntities);
                const records = this.buildRecords(canonical);
                const strokes = this.buildStrokes(canonical, handleForcesMap);
                const statistics = this.computeStatistics(strokes);

                return {
                    sessionId,
                    deviceName: connectedDevice?.deviceName,
                    records,
                    strokes,
                    statistics,
                    laps:
                        lapEntities.length > 0
                            ? buildLapsFromMarkers(strokes, lapEntities)
                            : detectLaps(strokes),
                    ...SessionAnalysisService.computeSessionBalance(strokes),
                };
            },
        );
    }

    loadFromJson(exportSession: IExportSession): ISessionAnalysis {
        const records: Array<ISessionRecord> = sessionStrokeRecords(exportSession.records).map(
            (entry: IExportRecord, index: number): ISessionRecord => ({
                strokeIndex: entry.strokeCount ?? index,
                timeStamp: new Date(entry.timeStamp).getTime(),
                elapsedTime: entry.elapsedTime,
                speed: entry.speed,
                avgStrokePower: entry.avgStrokePower,
                strokeRate: entry.strokeRate,
                distPerStroke: entry.distPerStroke,
                distance: entry.distance,
                driveDuration: entry.driveDuration,
                recoveryDuration: entry.recoveryDuration,
                dragFactor: entry.dragFactor,
                heartRate: entry.heartRate,
            }),
        );

        const uniqueRecords = new Map<number, ISessionRecord>();
        for (const record of records) {
            uniqueRecords.set(record.strokeIndex, record);
        }
        const canonicalRecords = Array.from(uniqueRecords.values()).sort(
            (a: ISessionRecord, b: ISessionRecord): number => a.timeStamp - b.timeStamp,
        );

        const strokes: Array<ISessionStroke> = canonicalRecords.map(
            (record: ISessionRecord): ISessionStroke => {
                const handleForce: IExportHandleForces | undefined =
                    exportSession.handleForces[record.strokeIndex];
                const forces: Array<number> = handleForce?.handleForces ?? [];
                const {
                    peakForce: computedPeakForce,
                    peakForceIndex,
                }: { peakForce: number; peakForceIndex: number } = findPeakForce(forces);
                const driveLength = handleForce?.driveLength ?? 0;
                const forceCurve = handleForce?.forceCurve ?? buildLegacyForceCurve(forces, driveLength);

                return {
                    ...record,
                    peakForce: computedPeakForce,
                    peakForcePositionNorm: calculatePeakPosition(
                        handleForce?.forceCurve,
                        driveLength,
                        peakForceIndex,
                        forces.length,
                    ),
                    driveLength,
                    handleForces: forces,
                    forceCurve,
                };
            },
        );

        const sessionId = exportSession.sessionId;
        const statistics = this.computeStatistics(strokes);
        const exportedLaps = exportSession.laps ?? [];

        return {
            sessionId,
            deviceName: exportSession.deviceName,
            records: canonicalRecords,
            strokes,
            statistics,
            laps: exportedLaps.length > 0 ? buildLapsFromMarkers(strokes, exportedLaps) : detectLaps(strokes),
            ...SessionAnalysisService.computeSessionBalance(strokes),
        };
    }

    private static computeSessionBalance(strokes: Array<ISessionStroke>): {
        powerBalance: number | undefined;
        powerBalanceConsistency: number | undefined;
    } {
        const { powerBalance, ratios }: { powerBalance: number; ratios: ReadonlyArray<number> } =
            computeBalanceMetrics(strokesToBalanceInput(strokes));

        if (ratios.length === 0) {
            return { powerBalance: undefined, powerBalanceConsistency: undefined };
        }

        if (ratios.length < MIN_BALANCE_PAIRS_FOR_CONSISTENCY) {
            return { powerBalance, powerBalanceConsistency: undefined };
        }

        const variance: number =
            ratios.reduce((sum: number, ratio: number): number => sum + (ratio - powerBalance) ** 2, 0) /
            ratios.length;

        return { powerBalance, powerBalanceConsistency: Math.sqrt(variance) };
    }

    private buildHandleForcesMap(entities: Array<IHandleForcesEntity>): Record<number, IHandleForcesEntity> {
        const map: Record<number, IHandleForcesEntity> = {};
        for (const entity of entities) {
            map[entity.strokeId] = entity;
        }

        return map;
    }

    private buildRecords(metricsEntities: Array<IMetricsEntity>): Array<ISessionRecord> {
        const newestByStroke = new Map<number, IMetricsEntity>();
        for (const metric of metricsEntities) {
            newestByStroke.set(metric.strokeCount, metric);
        }

        return Array.from(newestByStroke.values())
            .sort((a: IMetricsEntity, b: IMetricsEntity): number => a.timeStamp - b.timeStamp)
            .map((metric: IMetricsEntity): ISessionRecord => ({
                strokeIndex: metric.strokeCount,
                timeStamp: metric.timeStamp,
                elapsedTime: metric.elapsedTime,
                speed: metric.speed,
                avgStrokePower: metric.avgStrokePower,
                strokeRate: metric.strokeRate,
                distPerStroke: metric.distPerStroke,
                distance: metric.distance,
                driveDuration: metric.driveDuration,
                recoveryDuration: metric.recoveryDuration,
                dragFactor: metric.dragFactor,
                heartRate: metric.heartRate,
            }));
    }

    private buildStrokes(
        metricsEntities: Array<IMetricsEntity>,
        handleForcesMap: Record<number, IHandleForcesEntity>,
    ): Array<ISessionStroke> {
        const uniqueByStrokeCount = new Map<number, IMetricsEntity>();
        for (const metric of metricsEntities) {
            uniqueByStrokeCount.set(metric.strokeCount, metric);
        }

        return Array.from(uniqueByStrokeCount.values()).map((metric: IMetricsEntity): ISessionStroke => {
            const handleForce = handleForcesMap[metric.strokeCount];
            const physicalCurve =
                metric.forceCurveStatus === "complete" ? metric.forceCurve?.samples : undefined;
            const forces: Array<number> =
                physicalCurve?.map((point: IForceCurvePoint): number => point.force) ??
                handleForce?.handleForces ??
                [];
            const { peakForce, peakForceIndex }: { peakForce: number; peakForceIndex: number } =
                findPeakForce(forces);
            const driveLength = metric.forceCurve?.driveLength ?? handleForce?.driveLength ?? 0;
            const forceCurve =
                physicalCurve ?? handleForce?.forceCurve ?? buildLegacyForceCurve(forces, driveLength);

            return {
                strokeIndex: metric.strokeCount,
                timeStamp: metric.timeStamp,
                elapsedTime: metric.elapsedTime,
                speed: metric.speed,
                avgStrokePower: metric.avgStrokePower,
                strokeRate: metric.strokeRate,
                distPerStroke: metric.distPerStroke,
                distance: metric.distance,
                driveDuration: metric.driveDuration,
                recoveryDuration: metric.recoveryDuration,
                dragFactor: metric.dragFactor,
                heartRate: metric.heartRate,
                peakForce,
                peakForcePositionNorm: calculatePeakPosition(
                    physicalCurve ?? handleForce?.forceCurve,
                    driveLength,
                    peakForceIndex,
                    forces.length,
                ),
                driveLength,
                handleForces: forces,
                forceCurve,
            };
        });
    }

    private computeStatistics(strokes: Array<ISessionStroke>): ISessionStatistics {
        if (strokes.length === 0) {
            return this.emptyStatistics();
        }

        const lastStroke = strokes[strokes.length - 1];

        const max: ISessionMaximums = {
            speed: 0,
            strokePower: 0,
            strokeRate: 0,
            peakForce: 0,
            distPerStroke: 0,
            driveLength: 0,
            driveDuration: 0,
            recoveryDuration: 0,
        };

        let sumSpeed = 0;
        let sumPower = 0;
        let sumStrokeRate = 0;
        let sumDistPerStroke = 0;
        let sumDriveLength = 0;
        let sumDriveDuration = 0;
        let sumRecoveryDuration = 0;
        let sumDragFactor = 0;
        let sumHeartRate = 0;
        let sumPeakForcePositionNorm = 0;
        let heartRateCount = 0;

        for (const stroke of strokes) {
            if (stroke.speed > max.speed) {
                max.speed = stroke.speed;
            }
            if (stroke.avgStrokePower > max.strokePower) {
                max.strokePower = stroke.avgStrokePower;
            }
            if (stroke.strokeRate > max.strokeRate) {
                max.strokeRate = stroke.strokeRate;
            }
            if (stroke.peakForce > max.peakForce) {
                max.peakForce = stroke.peakForce;
            }
            if (stroke.distPerStroke > max.distPerStroke) {
                max.distPerStroke = stroke.distPerStroke;
            }
            if (stroke.driveLength > max.driveLength) {
                max.driveLength = stroke.driveLength;
            }
            if (stroke.driveDuration > max.driveDuration) {
                max.driveDuration = stroke.driveDuration;
            }
            if (stroke.recoveryDuration > max.recoveryDuration) {
                max.recoveryDuration = stroke.recoveryDuration;
            }

            sumSpeed += stroke.speed;
            sumPower += stroke.avgStrokePower;
            sumStrokeRate += stroke.strokeRate;
            sumDistPerStroke += stroke.distPerStroke;
            sumDriveLength += stroke.driveLength;
            sumDriveDuration += stroke.driveDuration;
            sumRecoveryDuration += stroke.recoveryDuration;
            sumDragFactor += stroke.dragFactor;
            sumPeakForcePositionNorm += stroke.peakForcePositionNorm;

            if (stroke.heartRate !== undefined) {
                sumHeartRate += stroke.heartRate.heartRate;
                heartRateCount++;
            }
        }

        const count = strokes.length;

        const avg: ISessionAverages = {
            speed: sumSpeed / count,
            strokePower: sumPower / count,
            strokeRate: sumStrokeRate / count,
            peakForcePositionNorm: sumPeakForcePositionNorm / count,
            distPerStroke: sumDistPerStroke / count,
            driveLength: sumDriveLength / count,
            driveDuration: sumDriveDuration / count,
            recoveryDuration: sumRecoveryDuration / count,
            heartRate: heartRateCount > 0 ? sumHeartRate / heartRateCount : undefined,
            dragFactor: sumDragFactor / count,
        };

        return {
            totalDistance: lastStroke.distance / 100,
            totalTime: lastStroke.elapsedTime,
            totalStrokeCount: lastStroke.strokeIndex,
            max,
            avg,
        };
    }

    private emptyStatistics(): ISessionStatistics {
        return {
            totalDistance: 0,
            totalTime: 0,
            totalStrokeCount: 0,
            max: {
                speed: 0,
                strokePower: 0,
                strokeRate: 0,
                peakForce: 0,
                distPerStroke: 0,
                driveLength: 0,
                driveDuration: 0,
                recoveryDuration: 0,
            },
            avg: {
                speed: 0,
                strokePower: 0,
                strokeRate: 0,
                peakForcePositionNorm: 0,
                distPerStroke: 0,
                driveLength: 0,
                driveDuration: 0,
                recoveryDuration: 0,
                heartRate: undefined,
                dragFactor: 0,
            },
        };
    }
}
