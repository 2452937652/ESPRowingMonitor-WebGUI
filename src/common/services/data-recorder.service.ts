import { Injectable } from "@angular/core";
import { Dexie, IndexableTypePart, liveQuery, Table } from "dexie";
import { exportDB, ExportProgress, importInto, peakImportFile } from "dexie-export-import";
import { ImportProgress } from "dexie-export-import/dist/import";
import { filter, from, Observable } from "rxjs";

import { IForceCurvePoint, ISessionData, ISessionSummary } from "../common.interfaces";
import {
    IConnectedDeviceEntity,
    IDeltaTimesEntity,
    IExportHandleForces,
    IExportRecord,
    IExportSession,
    IHandleForcesEntity,
    ILapEntity,
    ILapExport,
    IMetricsEntity,
    ISessionMetadataEntity,
    IStrokePersistenceIdentity,
    LapType,
} from "../database.interfaces";
import { appDB } from "../utils/app-database";
import { createSessionFitFile } from "../utils/fit-file/fit-file";
import { downloadFiles } from "../utils/utility.functions";

interface IStrokePersistenceContext {
    sessionId: number;
    timeStamp: number;
    strokeKey: string;
    hasV2Identity: boolean;
}

@Injectable({
    providedIn: "root",
})
export class DataRecorderService {
    private _sessionId: number = Date.now();
    private lastAllocatedTimestamp: number = 0;

    get currentSessionId(): number {
        return this._sessionId;
    }

    addConnectedDevice(deviceName: string): Promise<number> {
        const sessionId = this.currentSessionId;

        return appDB.connectedDevice.put({ deviceName, sessionId });
    }

    async addLap(strokeIndex: number, type: LapType, isPause: boolean = false): Promise<number> {
        const timeStamp = await this.allocateTimestamp(appDB.laps);

        return appDB.laps.add({ sessionId: this.currentSessionId, timeStamp, strokeIndex, type, isPause });
    }

    async addDeltaTimes(deltaTimes: Array<number>): Promise<number> {
        const sessionId = this.currentSessionId;
        const timeStamp = await this.allocateTimestamp(appDB.deltaTimes);

        return appDB.deltaTimes.put({
            sessionId,
            timeStamp,
            deltaTimes,
        });
    }

    addSessionData(rowingData: ISessionData): Promise<void> {
        const sessionId: number = this.currentSessionId;

        return appDB.transaction("rw", appDB.sessionData, appDB.handleForces, async (): Promise<void> => {
            const metricsTimeStamp = await this.allocateTimestamp(appDB.sessionData);
            const existingHandleForces = await appDB.handleForces
                .where({ sessionId, strokeId: rowingData.strokeCount })
                .last();
            const handleForcesTimeStamp =
                existingHandleForces?.timeStamp ?? (await this.allocateTimestamp(appDB.handleForces));

            await Promise.all([
                appDB.sessionData.add({
                    sessionId,
                    timeStamp: metricsTimeStamp,
                    avgStrokePower: rowingData.avgStrokePower,
                    distance: rowingData.distance,
                    distPerStroke: rowingData.distPerStroke,
                    dragFactor: rowingData.dragFactor,
                    driveDuration: rowingData.driveDuration,
                    recoveryDuration: rowingData.recoveryDuration,
                    speed: rowingData.speed,
                    strokeCount: rowingData.strokeCount,
                    strokeRate: rowingData.strokeRate,
                    elapsedTime: rowingData.elapsedTime,
                    heartRate: rowingData.heartRate,
                }),
                appDB.handleForces.put({
                    timeStamp: handleForcesTimeStamp,
                    sessionId,
                    strokeId: rowingData.strokeCount,
                    handleForces: rowingData.handleForces,
                    driveLength: rowingData.driveLength,
                }),
            ]);
        });
    }

    /**
     * Persist one logical stroke. Later recovery or curve notifications update the
     * same row; completed recovery metrics and force curves are sticky once stored.
     */
    upsertSessionStroke(rowingData: ISessionData, identity: IStrokePersistenceIdentity): Promise<number> {
        const sessionId = this.currentSessionId;
        const hasV2Identity = identity.sourceEpoch !== undefined && identity.sourceStrokeId !== undefined;
        const strokeKey = this.getStrokeKey(rowingData, identity);

        return appDB.transaction("rw", appDB.sessionData, appDB.handleForces, async (): Promise<number> => {
            const existing = await appDB.sessionData
                .where("[sessionId+strokeKey]")
                .equals([sessionId, strokeKey])
                .first();
            const timeStamp = existing?.timeStamp ?? (await this.allocateTimestamp(appDB.sessionData));
            const context: IStrokePersistenceContext = { sessionId, timeStamp, strokeKey, hasV2Identity };
            const entity = this.mergeStrokeEntity(rowingData, identity, existing, context);
            await appDB.sessionData.put(entity);
            await this.upsertLegacyHandleForces(rowingData, identity, sessionId, hasV2Identity);

            return timeStamp;
        });
    }

    /** Record the explicit stop boundary for v5 summaries and file exports. */
    finishSession(sessionId: number, finishAt: number, elapsedTime: number): Promise<number> {
        const metadata: ISessionMetadataEntity = { sessionId, finishAt, elapsedTime };

        return appDB.sessionMetadata.put(metadata);
    }

    async hasSessions(): Promise<boolean> {
        return (await appDB.sessionData.count()) > 0;
    }

    deleteSession(sessionId: number): Promise<void> {
        return appDB.transaction(
            "rw",
            [
                appDB.sessionData,
                appDB.deltaTimes,
                appDB.handleForces,
                appDB.connectedDevice,
                appDB.laps,
                appDB.sessionMetadata,
                appDB.sessionUploads,
            ],
            async (): Promise<void> => {
                await Promise.all([
                    appDB.sessionData.where({ sessionId }).delete(),
                    appDB.deltaTimes.where({ sessionId }).delete(),
                    appDB.handleForces.where({ sessionId }).delete(),
                    appDB.connectedDevice.where({ sessionId }).delete(),
                    appDB.laps.where({ sessionId }).delete(),
                    appDB.sessionMetadata.delete(sessionId),
                    appDB.sessionUploads.where({ sessionId }).delete(),
                ]);
            },
        );
    }

    async export(progressCallback?: (progress: ExportProgress) => boolean): Promise<void> {
        const database = await exportDB(appDB, { progressCallback });
        const name = `${new Date().toDateTimeStringFormat()} - database.json`;

        downloadFiles([{ blob: database, name }]);
    }

    async exportSessionToJson(sessionId: number): Promise<void> {
        const [deltaTimes, exportSession]: [Array<number>, IExportSession] = await Promise.all([
            this.getDeltaTimes(sessionId),
            this.buildExportSession(sessionId),
        ]);

        const files: Array<{ blob: Blob; name: string }> = [
            {
                blob: new Blob([JSON.stringify(exportSession)], { type: "application/json" }),
                name: `${new Date(sessionId).toDateTimeStringFormat()} - session.json`,
            },
        ];

        if (deltaTimes.length > 0) {
            const blob = new Blob([JSON.stringify(deltaTimes)], { type: "application/json" });
            const name = `${new Date(sessionId).toDateTimeStringFormat()} - deltaTimes.json`;
            files.push({ blob, name });
        }

        downloadFiles(files);
    }

    async generateFitFile(sessionId: number): Promise<Blob> {
        const exportSession = await this.buildExportSession(sessionId);
        const fitData = createSessionFitFile(exportSession);

        return new Blob([fitData as ArrayBuffer], { type: "application/vnd.ant.fit" });
    }

    async exportSessionToFit(sessionId: number): Promise<void> {
        const blob = await this.generateFitFile(sessionId);
        const name = `${new Date(sessionId).toDateTimeStringFormat()} - session.fit`;
        downloadFiles([{ blob, name }]);
    }

    async exportSessionToCsv(sessionId: number): Promise<void> {
        const [deltaTimes, exportSession]: [Array<number>, IExportSession] = await Promise.all([
            this.getDeltaTimes(sessionId),
            this.buildExportSession(sessionId),
        ]);

        const csvContent = this.formatSessionCsv(exportSession);

        const files: Array<{ blob: Blob; name: string }> = [
            {
                blob: new Blob([csvContent], { type: "text/csv" }),
                name: `${new Date(sessionId).toDateTimeStringFormat()} - session.csv`,
            },
        ];

        if (deltaTimes.length > 0) {
            const deltaTimesContent = this.formatDeltaTimesCsv(deltaTimes);
            const blob = new Blob([deltaTimesContent], { type: "text/csv" });
            const name = `${new Date(sessionId).toDateTimeStringFormat()} - deltaTimes.csv`;
            files.push({ blob, name });
        }

        downloadFiles(files);
    }

    getSessionSummaries$(): Observable<Array<ISessionSummary>> {
        return from(
            liveQuery((): Promise<Array<ISessionSummary | undefined>> =>
                appDB.transaction(
                    "r",
                    appDB.sessionData,
                    appDB.connectedDevice,
                    appDB.sessionMetadata,
                    async (): Promise<Array<ISessionSummary | undefined>> => {
                        const uniqueSessionIds = [];

                        try {
                            uniqueSessionIds.push(
                                ...(await appDB.sessionData.orderBy("sessionId").uniqueKeys()),
                            );
                        } catch (error) {
                            if (!(error instanceof Dexie.UnknownError)) {
                                console.error("Error fetching unique session IDs:", error);
                            }
                        }

                        return Promise.all(
                            uniqueSessionIds.map(
                                async (
                                    sessionId: IndexableTypePart,
                                ): Promise<ISessionSummary | undefined> => {
                                    const [connectedDevice, first, last, metadata]: [
                                        IConnectedDeviceEntity | undefined,
                                        IMetricsEntity | undefined,
                                        IMetricsEntity | undefined,
                                        ISessionMetadataEntity | undefined,
                                    ] = await Promise.all([
                                        appDB.connectedDevice.where({ sessionId }).last(),
                                        appDB.sessionData.where({ sessionId }).first(),
                                        appDB.sessionData.where({ sessionId }).last(),
                                        appDB.sessionMetadata.get(Number(sessionId)),
                                    ]);

                                    if (first === undefined || last === undefined) {
                                        return undefined;
                                    }

                                    return {
                                        sessionId: last.sessionId,
                                        deviceName: connectedDevice?.deviceName,
                                        startTime: first.timeStamp - first.driveDuration / 1000,
                                        finishTime: metadata?.finishAt ?? last.timeStamp,
                                        elapsedTime: metadata?.elapsedTime ?? last.elapsedTime,
                                        distance: last.distance,
                                        strokeCount: last.strokeCount,
                                    };
                                },
                            ),
                        );
                    },
                ),
            ),
        ).pipe(
            filter(
                (value: Array<ISessionSummary | undefined>): value is Array<ISessionSummary> =>
                    value !== undefined,
            ),
        );
    }

    getLaps(sessionId: number): Promise<Array<ILapEntity>> {
        return appDB.laps.where({ sessionId }).sortBy("timeStamp");
    }

    async import(blob: Blob, progressCallback?: (progress: ImportProgress) => boolean): Promise<void> {
        const importMeta = await peakImportFile(blob);
        console.log("Database name:", importMeta.data.databaseName);
        console.log("Database version:", importMeta.data.databaseVersion);
        console.log(
            "Tables:",
            importMeta.data.tables
                .map(
                    (table: { name: string; schema: string; rowCount: number }): string =>
                        `${table.name} (${table.rowCount} rows)`,
                )
                .join("\n\t"),
        );

        return importInto(appDB, blob, {
            overwriteValues: true,
            progressCallback,
        });
    }

    async reset(connectedDeviceName?: string): Promise<void> {
        this._sessionId = Date.now();

        if (connectedDeviceName) {
            await this.addConnectedDevice(connectedDeviceName);
        }
    }

    private formatSessionCsv(exportSession: IExportSession): string {
        const {
            records,
            handleForces,
        }: { records: Array<IExportRecord>; handleForces: Record<number, IExportHandleForces> } =
            exportSession;
        const headers = [
            "Stroke Number",
            "Elapsed Time",
            "Distance (m)",
            "Pace (500m)",
            "Speed (km/h)",
            "Stroke Power (W)",
            "Stroke Rate",
            "Distance per Stroke (m)",
            "Drive Duration (s)",
            "Recovery Duration (s)",
            "Drive Length (m)",
            "Heart Rate",
            "Drag Factor",
            "Peak Force (N)",
            "Peak Force Position (%)",
            "Handle Forces (N)",
        ].join(",");

        let csvBody = `${headers}\n`;
        let previousStroke: IExportRecord | undefined = records[0];

        for (const data of records) {
            if (this.isDuplicateLogicalStroke(previousStroke, data)) {
                continue;
            }

            csvBody += `${this.formatSessionCsvRow(data, previousStroke, handleForces)}\n`;
            previousStroke = data;
        }

        return `${csvBody}\n`;
    }

    private formatDeltaTimesCsv(deltaTimes: Array<number>): string {
        return deltaTimes.map((deltaTime: number): string => deltaTime.toString()).join("\n");
    }

    private async getDeltaTimes(sessionId: number): Promise<Array<number>> {
        return (await appDB.deltaTimes.where({ sessionId }).toArray()).reduce(
            (previousValue: Array<number>, currentValue: IDeltaTimesEntity): Array<number> => {
                previousValue.push(...currentValue.deltaTimes);

                return previousValue;
            },
            [],
        );
    }

    private async buildExportSession(sessionId: number): Promise<IExportSession> {
        return appDB.transaction(
            "r",
            appDB.sessionData,
            appDB.handleForces,
            appDB.connectedDevice,
            appDB.laps,
            appDB.sessionMetadata,
            async (): Promise<IExportSession> => {
                const [metricsEntities, handleForcesEntities, connectedDevice, lapEntities, metadata]: [
                    Array<IMetricsEntity>,
                    Array<IHandleForcesEntity>,
                    { sessionId: number; deviceName: string } | undefined,
                    Array<ILapEntity>,
                    ISessionMetadataEntity | undefined,
                ] = await Promise.all([
                    appDB.sessionData.where({ sessionId }).toArray(),
                    appDB.handleForces.where({ sessionId }).toArray(),
                    appDB.connectedDevice.where({ sessionId }).last(),
                    appDB.laps.where({ sessionId }).sortBy("timeStamp"),
                    appDB.sessionMetadata.get(sessionId),
                ]);

                const records: Array<IExportRecord> = [];
                let totalWork = 0;

                for (const metric of metricsEntities) {
                    if (metric.isExtendedMetricsPending !== true) {
                        totalWork += metric.avgStrokePower * (metric.driveDuration + metric.recoveryDuration);
                    }
                    records.push({
                        avgStrokePower: metric.avgStrokePower,
                        distance: metric.distance,
                        distPerStroke: metric.distPerStroke,
                        dragFactor: metric.dragFactor,
                        driveDuration: metric.driveDuration,
                        recoveryDuration: metric.recoveryDuration,
                        speed: metric.speed,
                        strokeCount: metric.strokeCount,
                        strokeRate: metric.strokeRate,
                        elapsedTime: metric.elapsedTime,
                        heartRate: metric.heartRate,
                        timeStamp: new Date(metric.timeStamp),
                        totalWork,
                        strokeKey: metric.strokeKey,
                        sourceEpoch: metric.sourceEpoch,
                        sourceStrokeId: metric.sourceStrokeId,
                        forceCurve: metric.forceCurve,
                        forceCurveStatus: metric.forceCurveStatus,
                        isExtendedMetricsPending: metric.isExtendedMetricsPending,
                    });
                }

                const handleForces: Record<number, IExportHandleForces> = {};
                for (const entity of handleForcesEntities) {
                    const { peakForce, peakForceIndex }: { peakForce: number; peakForceIndex: number } =
                        entity.handleForces.reduce(
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

                    handleForces[entity.strokeId] = {
                        peakForce,
                        peakForcePositionNorm:
                            entity.handleForces.length > 1
                                ? (peakForceIndex / (entity.handleForces.length - 1)) * 100
                                : 0,
                        driveLength: entity.driveLength,
                        handleForces: entity.handleForces,
                        forceCurve: entity.forceCurve,
                        forceCurveStatus: entity.forceCurveStatus,
                    };
                }

                for (const record of records) {
                    if (record.strokeKey === undefined || record.forceCurveStatus !== "complete") {
                        continue;
                    }

                    const curve = this.getExportHandleForce(record, handleForces);
                    if (curve !== undefined) {
                        handleForces[record.strokeCount] = curve;
                    }
                }

                return {
                    sessionId,
                    deviceName: connectedDevice?.deviceName,
                    records,
                    handleForces,
                    laps: lapEntities.map((lap: ILapEntity): ILapExport => ({
                        timeStamp: lap.timeStamp,
                        strokeIndex: lap.strokeIndex,
                        type: lap.type,
                        isPause: lap.isPause,
                    })),
                    finishAt: metadata?.finishAt,
                    elapsedTime: metadata?.elapsedTime,
                };
            },
        );
    }

    private mergeStrokeEntity(
        rowingData: ISessionData,
        identity: IStrokePersistenceIdentity,
        existing: IMetricsEntity | undefined,
        context: IStrokePersistenceContext,
    ): IMetricsEntity {
        return {
            sessionId: context.sessionId,
            timeStamp: context.timeStamp,
            strokeKey: context.strokeKey,
            sourceEpoch: context.hasV2Identity ? identity.sourceEpoch : undefined,
            sourceStrokeId: context.hasV2Identity ? identity.sourceStrokeId : undefined,
            distance: rowingData.distance,
            distPerStroke: rowingData.distPerStroke,
            driveDuration: rowingData.driveDuration,
            speed: rowingData.speed,
            strokeCount: rowingData.strokeCount,
            strokeRate: rowingData.strokeRate,
            elapsedTime: existing?.elapsedTime ?? rowingData.elapsedTime,
            heartRate: existing?.heartRate ?? rowingData.heartRate,
            ...this.mergeExtendedMetrics(rowingData, identity, existing),
            ...this.mergeForceCurve(identity, existing, context),
        };
    }

    private mergeExtendedMetrics(
        rowingData: ISessionData,
        identity: IStrokePersistenceIdentity,
        existing: IMetricsEntity | undefined,
    ): Pick<
        IMetricsEntity,
        "avgStrokePower" | "dragFactor" | "recoveryDuration" | "isExtendedMetricsPending"
    > {
        if (
            identity.isExtendedMetricsPending === true &&
            existing !== undefined &&
            existing.isExtendedMetricsPending !== true
        ) {
            return {
                avgStrokePower: existing.avgStrokePower,
                dragFactor: existing.dragFactor,
                recoveryDuration: existing.recoveryDuration,
                isExtendedMetricsPending: existing.isExtendedMetricsPending,
            };
        }

        return {
            avgStrokePower: rowingData.avgStrokePower,
            dragFactor: rowingData.dragFactor,
            recoveryDuration: rowingData.recoveryDuration,
            isExtendedMetricsPending: identity.isExtendedMetricsPending,
        };
    }

    private mergeForceCurve(
        identity: IStrokePersistenceIdentity,
        existing: IMetricsEntity | undefined,
        context: IStrokePersistenceContext,
    ): Pick<IMetricsEntity, "forceCurve" | "forceCurveStatus"> {
        if (existing?.forceCurveStatus === "complete" && existing.forceCurve !== undefined) {
            return { forceCurve: existing.forceCurve, forceCurveStatus: existing.forceCurveStatus };
        }

        if (identity.forceCurveStatus === "complete" && identity.forceCurve !== undefined) {
            return { forceCurve: identity.forceCurve, forceCurveStatus: "complete" };
        }

        const forceCurveStatus =
            identity.forceCurveStatus ??
            existing?.forceCurveStatus ??
            (!context.hasV2Identity ? "legacy" : undefined);

        return {
            forceCurve: identity.forceCurve ?? existing?.forceCurve,
            forceCurveStatus:
                forceCurveStatus === "complete" && identity.forceCurve === undefined
                    ? existing?.forceCurveStatus
                    : forceCurveStatus,
        };
    }

    private async upsertLegacyHandleForces(
        rowingData: ISessionData,
        identity: IStrokePersistenceIdentity,
        sessionId: number,
        hasV2Identity: boolean,
    ): Promise<void> {
        if (hasV2Identity) {
            return;
        }
        if (identity.forceCurve === undefined && rowingData.handleForces.length === 0) {
            return;
        }

        const strokeId = identity.logicalStrokeCount ?? rowingData.strokeCount;
        const existing = await appDB.handleForces.where({ sessionId, strokeId }).last();
        const entity = await this.mergeLegacyHandleForces(
            rowingData,
            identity,
            existing,
            sessionId,
            strokeId,
        );
        await appDB.handleForces.put(entity);
    }

    private async mergeLegacyHandleForces(
        rowingData: ISessionData,
        identity: IStrokePersistenceIdentity,
        existing: IHandleForcesEntity | undefined,
        sessionId: number,
        strokeId: number,
    ): Promise<IHandleForcesEntity> {
        const forceCurve = identity.forceCurve?.samples;
        const incomingForces =
            forceCurve?.map((point: IForceCurvePoint): number => point.force) ?? rowingData.handleForces;
        const entity: IHandleForcesEntity = {
            timeStamp: existing?.timeStamp ?? (await this.allocateTimestamp(appDB.handleForces)),
            sessionId,
            strokeId,
            handleForces: incomingForces,
            driveLength: identity.forceCurve?.driveLength ?? rowingData.driveLength,
            forceCurve: forceCurve ?? existing?.forceCurve,
            forceCurveStatus: identity.forceCurveStatus ?? existing?.forceCurveStatus ?? "legacy",
        };

        if (existing?.forceCurveStatus === "complete") {
            entity.handleForces = existing.handleForces;
            entity.driveLength = existing.driveLength;
            entity.forceCurve = existing.forceCurve;
            entity.forceCurveStatus = existing.forceCurveStatus;
        }

        return entity;
    }

    private getStrokeKey(rowingData: ISessionData, identity: IStrokePersistenceIdentity): string {
        if (identity.sourceEpoch !== undefined && identity.sourceStrokeId !== undefined) {
            return `v2:${identity.sourceEpoch}:${identity.sourceStrokeId}`;
        }

        return `legacy:${identity.logicalStrokeCount ?? rowingData.strokeCount}`;
    }

    private reserveTimestamp(): number {
        this.lastAllocatedTimestamp = Math.max(Date.now(), this.lastAllocatedTimestamp + 1);

        return this.lastAllocatedTimestamp;
    }

    private async allocateTimestamp<T extends { timeStamp: number }>(
        table: Table<T, number>,
    ): Promise<number> {
        let timeStamp = this.reserveTimestamp();

        while ((await table.get(timeStamp)) !== undefined) {
            timeStamp = this.reserveTimestamp();
        }

        return timeStamp;
    }

    private isDuplicateLogicalStroke(previous: IExportRecord | undefined, current: IExportRecord): boolean {
        if (previous === undefined || previous === current) {
            return false;
        }

        if (previous.strokeKey !== undefined && current.strokeKey !== undefined) {
            return previous.strokeKey === current.strokeKey;
        }

        return (
            previous.strokeKey === undefined &&
            current.strokeKey === undefined &&
            previous.strokeCount === current.strokeCount
        );
    }

    private formatSessionCsvRow(
        data: IExportRecord,
        previous: IExportRecord | undefined,
        handleForces: Record<number, IExportHandleForces>,
    ): string {
        const previousRecord = previous ?? data;
        const calculatedSpeed = this.calculateExportSpeed(data, previousRecord);
        const handleForce = this.getExportHandleForce(data, handleForces) ?? {
            handleForces: [],
            driveLength: 0,
            peakForce: 0,
            peakForcePositionNorm: 0,
        };
        const isCurveAvailable =
            data.strokeKey === undefined || this.getExportHandleForce(data, handleForces) !== undefined;
        const forceValues = `"${handleForce.handleForces.map((force: number): string => force.toFixed(2)).join(",")}"`;
        const heartRate = data.heartRate?.heartRate ?? "NaN";
        const isPending = data.isExtendedMetricsPending === true;
        const isInvalidSpeed = isNaN(calculatedSpeed);

        return [
            data.strokeCount.toString(),
            data.elapsedTime.toFixed(2),
            (data.distance / 100).toString(),
            (isInvalidSpeed || calculatedSpeed === 0 ? 0 : 500 / calculatedSpeed).toFixed(2),
            (isInvalidSpeed ? 0 : calculatedSpeed * 3.6).toFixed(2),
            isPending ? "" : data.avgStrokePower.toString(),
            Math.round(data.strokeRate).toString(),
            data.distPerStroke.toString(),
            data.driveDuration.toFixed(2),
            isPending ? "" : data.recoveryDuration.toFixed(2),
            isCurveAvailable ? handleForce.driveLength.toFixed(2) : "",
            heartRate.toString(),
            isPending ? "" : data.dragFactor.toString(),
            isCurveAvailable ? handleForce.peakForce.toFixed(2) : "",
            isCurveAvailable ? handleForce.peakForcePositionNorm.toFixed(1) : "",
            isCurveAvailable ? forceValues : "",
        ].join(",");
    }

    private calculateExportSpeed(data: IExportRecord, previous: IExportRecord): number {
        if (previous.distance !== 0) {
            return (data.strokeRate / 60) * data.distPerStroke;
        }

        return data.elapsedTime > 0 ? data.distance / 100 / data.elapsedTime : 0;
    }

    private getExportHandleForce(
        record: IExportRecord,
        handleForcesByStroke: Record<number, IExportHandleForces>,
    ): IExportHandleForces | undefined {
        if (record.strokeKey !== undefined && record.forceCurveStatus !== "legacy") {
            if (record.forceCurveStatus !== "complete" || record.forceCurve === undefined) {
                return undefined;
            }

            const samples = record.forceCurve.samples;
            const forceValues = samples.map((sample: IForceCurvePoint): number => sample.force);
            const peakForce = samples.reduce(
                (maximum: number, sample: IForceCurvePoint): number => Math.max(maximum, sample.force),
                0,
            );
            const peakForceIndex = samples.findIndex(
                (sample: IForceCurvePoint): boolean => sample.force === peakForce,
            );
            const peakDistance = samples[peakForceIndex]?.distance ?? 0;
            const driveLength = record.forceCurve.driveLength;
            const peakForcePositionNorm =
                Number.isFinite(driveLength) && driveLength > 0 && Number.isFinite(peakDistance)
                    ? (peakDistance / driveLength) * 100
                    : 0;

            return {
                peakForce,
                peakForcePositionNorm,
                driveLength,
                handleForces: forceValues,
                forceCurve: samples,
                forceCurveStatus: "complete",
            };
        }

        return handleForcesByStroke[record.strokeCount];
    }
}
