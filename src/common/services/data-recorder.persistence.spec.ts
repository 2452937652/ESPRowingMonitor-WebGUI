import { TestBed } from "@angular/core/testing";
import { firstValueFrom } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IForceCurve, ISessionData } from "../common.interfaces";
import {
    IDeltaTimesEntity,
    IExportSession,
    IHandleForcesEntity,
    IMetricsEntity,
} from "../database.interfaces";
import { appDB } from "../utils/app-database";

import { DataRecorderService } from "./data-recorder.service";

describe("DataRecorderService v5 persistence", (): void => {
    it("preserves measured cadence and distance in a same-key update and exports recorded speed", async (): Promise<void> => {
        const identity = { sourceEpoch: 10, sourceStrokeId: 4 };
        await service.upsertSessionStroke(sessionData(), identity);
        await service.upsertSessionStroke(
            { ...sessionData(), strokeRate: 0, distPerStroke: 0, recoveryDuration: 2 },
            identity,
        );
        const internals = service as unknown as {
            buildExportSession(id: number): Promise<IExportSession>;
            formatSessionCsv(session: IExportSession): string;
        };
        const exported = await internals.buildExportSession(fixedTime);
        expect(exported.records).toHaveLength(1);
        expect(exported.records[0]).toMatchObject({ strokeRate: 24, distPerStroke: 8, recoveryDuration: 2 });
        // a prior affected recording still has valid measured speed even with zero cadence.
        exported.records[0].strokeRate = 0;
        exported.records[0].distPerStroke = 0;
        const values = internals.formatSessionCsv(exported).trim().split("\n")[1].split(",");
        expect(values[4]).toBe("15.12");
    });
    const fixedTime = 1700000000000;
    let service: DataRecorderService;

    const sessionData = (): ISessionData => ({
        avgStrokePower: 150,
        distance: 5000,
        distPerStroke: 8,
        dragFactor: 110,
        driveDuration: 0.8,
        recoveryDuration: 1.2,
        speed: 4.2,
        strokeCount: 50,
        strokeRate: 24,
        elapsedTime: 1,
        peakForce: 300,
        peakForcePositionNorm: 50,
        handleForces: [80, 220, 90],
        driveLength: 1.5,
        totalWork: 0,
        powerBalance: 0.5,
    });

    const curve: IForceCurve = {
        strokeId: 7,
        driveLength: 1.5,
        driveDurationUs: 800000,
        samples: [
            { distance: 0, elapsedTimeUs: 0, force: 80 },
            { distance: 0.45, elapsedTimeUs: 400000, force: 220 },
            { distance: 1.5, elapsedTimeUs: 800000, force: 90 },
        ],
    };

    beforeEach((): void => {
        vi.spyOn(Date, "now").mockReturnValue(fixedTime);
        TestBed.configureTestingModule({ providers: [DataRecorderService] });
        service = TestBed.inject(DataRecorderService);
    });

    afterEach(async (): Promise<void> => {
        await appDB.sessionData.clear();
        await appDB.deltaTimes.clear();
        await appDB.handleForces.clear();
        await appDB.sessionMetadata.clear();
        vi.restoreAllMocks();
    });

    it("counts a legacy stroke once in JSON work even when it has repeated recording rows", async (): Promise<void> => {
        await service.addSessionData(sessionData());
        await service.addSessionData({ ...sessionData(), elapsedTime: 2, strokeRate: 0, distPerStroke: 0 });
        const result = await (
            service as unknown as { buildExportSession(id: number): Promise<IExportSession> }
        ).buildExportSession(service.currentSessionId);
        expect(result.records).toHaveLength(2);
        expect(result.records[1].totalWork).toBe(300);
    });

    it("upserts late recovery and curve data while keeping completed values sticky", async (): Promise<void> => {
        const pending: ISessionData = {
            ...sessionData(),
            avgStrokePower: 0,
            dragFactor: 0,
            recoveryDuration: 0,
            elapsedTime: 0.5,
            heartRate: { heartRate: 120, contactDetected: true },
        };
        await service.upsertSessionStroke(pending, {
            sourceEpoch: 12,
            sourceStrokeId: 7,
            forceCurveStatus: "pending",
            isExtendedMetricsPending: true,
        });
        const original = await appDB.sessionData.where({ sessionId: fixedTime }).first();

        await service.upsertSessionStroke(
            {
                ...sessionData(),
                elapsedTime: 4,
                heartRate: { heartRate: 150, contactDetected: true },
            },
            {
                sourceEpoch: 12,
                sourceStrokeId: 7,
                forceCurve: curve,
                forceCurveStatus: "complete",
                isExtendedMetricsPending: false,
            },
        );
        await service.upsertSessionStroke(pending, {
            sourceEpoch: 12,
            sourceStrokeId: 7,
            forceCurveStatus: "pending",
            isExtendedMetricsPending: true,
        });

        const rows = await appDB.sessionData.where({ sessionId: fixedTime }).toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0].timeStamp).toBe(original?.timeStamp);
        expect(rows[0].strokeKey).toBe("v2:12:7");
        expect(rows[0].avgStrokePower).toBe(150);
        expect(rows[0].dragFactor).toBe(110);
        expect(rows[0].recoveryDuration).toBe(1.2);
        expect(rows[0].isExtendedMetricsPending).toBe(false);
        expect(rows[0].forceCurve).toEqual(curve);
        expect(rows[0].forceCurveStatus).toBe("complete");
        expect(rows[0].elapsedTime).toBe(0.5);
        expect(rows[0].heartRate?.heartRate).toBe(120);

        const serviceInternals = service as unknown as {
            buildExportSession: (sessionId: number) => Promise<IExportSession>;
        };
        const exported = await serviceInternals.buildExportSession(fixedTime);
        expect(exported.records[0].sourceEpoch).toBe(12);
        expect(exported.records[0].sourceStrokeId).toBe(7);
        expect(exported.handleForces[50].forceCurve).toEqual(curve.samples);
        expect(exported.handleForces[50].peakForcePositionNorm).toBe(30);
    });

    it("allocates distinct primary keys to strokes inserted in the same millisecond", async (): Promise<void> => {
        const metrics = sessionData();
        await Promise.all([
            service.upsertSessionStroke(metrics, { sourceEpoch: 12, sourceStrokeId: 7 }),
            service.upsertSessionStroke(
                { ...metrics, strokeCount: 51 },
                {
                    sourceEpoch: 12,
                    sourceStrokeId: 8,
                },
            ),
        ]);

        const rows = await appDB.sessionData.where({ sessionId: fixedTime }).toArray();
        const timestamps = rows
            .map((row: IMetricsEntity): number => row.timeStamp)
            .sort((left: number, right: number): number => left - right);
        expect(rows).toHaveLength(2);
        expect(timestamps).toEqual([fixedTime, fixedTime + 1]);
    });

    it("allocates distinct keys to same-millisecond delta and legacy force inserts", async (): Promise<void> => {
        await Promise.all([
            service.addDeltaTimes([100]),
            service.addDeltaTimes([110]),
            service.upsertSessionStroke(sessionData(), { logicalStrokeCount: 50 }),
            service.upsertSessionStroke({ ...sessionData(), strokeCount: 51 }, { logicalStrokeCount: 51 }),
        ]);

        const deltaRows = await appDB.deltaTimes.where({ sessionId: fixedTime }).toArray();
        const forceRows = await appDB.handleForces.where({ sessionId: fixedTime }).toArray();
        expect(deltaRows).toHaveLength(2);
        expect(new Set(deltaRows.map((row: IDeltaTimesEntity): number => row.timeStamp)).size).toBe(2);
        expect(forceRows).toHaveLength(2);
        expect(new Set(forceRows.map((row: IHandleForcesEntity): number => row.timeStamp)).size).toBe(2);
    });

    it("preserves pending quality markers in JSON and blanks pending CSV fields", async (): Promise<void> => {
        await service.upsertSessionStroke(
            { ...sessionData(), avgStrokePower: 0, dragFactor: 0, recoveryDuration: 0 },
            {
                sourceEpoch: 12,
                sourceStrokeId: 7,
                forceCurveStatus: "pending",
                isExtendedMetricsPending: true,
            },
        );

        const serviceInternals = service as unknown as {
            buildExportSession: (sessionId: number) => Promise<IExportSession>;
            formatSessionCsv: (exportSession: IExportSession) => string;
        };
        const exportSession = await serviceInternals.buildExportSession(fixedTime);
        const jsonExport = JSON.parse(JSON.stringify(exportSession)) as IExportSession;
        const record = jsonExport.records[0];
        const csvRows = serviceInternals.formatSessionCsv(exportSession).trim().split("\n");
        const headers = csvRows[0].split(",");
        const values = csvRows[1].split(",");

        expect(record.isExtendedMetricsPending).toBe(true);
        expect(record.forceCurveStatus).toBe("pending");
        expect(values[headers.indexOf("Stroke Power (W)")]).toBe("");
        expect(values[headers.indexOf("Recovery Duration (s)")]).toBe("");
        expect(values[headers.indexOf("Drag Factor")]).toBe("");
        expect(values[headers.indexOf("Drive Length (m)")]).toBe("");
        expect(values[headers.indexOf("Handle Forces (N)")]).toBe("");
    });

    it("uses stop metadata for session finish time and elapsed time", async (): Promise<void> => {
        await service.upsertSessionStroke(sessionData(), { sourceEpoch: 12, sourceStrokeId: 7 });
        await service.finishSession(fixedTime, fixedTime + 120000, 94.5);

        const serviceInternals = service as unknown as {
            buildExportSession: (sessionId: number) => Promise<IExportSession>;
        };
        const exportSession = await serviceInternals.buildExportSession(fixedTime);

        expect(exportSession.finishAt).toBe(fixedTime + 120000);
        expect(exportSession.elapsedTime).toBe(94.5);

        const summary = (await firstValueFrom(service.getSessionSummaries$()))[0];
        expect(summary.finishTime).toBe(fixedTime + 120000);
        expect(summary.elapsedTime).toBe(94.5);
    });
});
