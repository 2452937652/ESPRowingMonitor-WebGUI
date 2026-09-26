import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import { IExportRecord, IExportSession, IMetricsEntity } from "../../../common/database.interfaces";
import { appDB } from "../../../common/utils/app-database";
import { captureRows } from "../../../common/utils/session-capture-2026-09-26.fixture";
import { ISessionStroke } from "../models/session-analysis.interfaces";

import { SessionAnalysisService } from "./session-analysis.service";

describe("September 26 real session regression", (): void => {
    it("recovers cadence and stroke distance for all 102 measured strokes without changing the raw recording", async (): Promise<void> => {
        TestBed.configureTestingModule({ providers: [SessionAnalysisService] });
        const service = TestBed.inject(SessionAnalysisService);
        const session: IExportSession = {
            sessionId: 926,
            records: captureRows.map(
                ([
                    strokeCount,
                    elapsedTime,
                    distance,
                    speed,
                    strokeRate,
                    distPerStroke,
                    driveDuration,
                    recoveryDuration,
                    avgStrokePower,
                    dragFactor,
                ]: Array<number>): IExportRecord => ({
                    strokeCount,
                    elapsedTime,
                    distance,
                    speed,
                    strokeRate,
                    distPerStroke,
                    driveDuration,
                    recoveryDuration,
                    avgStrokePower,
                    dragFactor,
                    totalWork: 0,
                    timeStamp: new Date(1_000_000 + elapsedTime * 1000),
                }),
            ),
            handleForces: {
                1: { driveLength: 0, handleForces: [10, 89, 20], peakForce: 89, peakForcePositionNorm: 50 },
            },
            laps: [],
        };
        const original = JSON.stringify(session);
        const result = service.loadFromJson(session);
        expect(result.strokes).toHaveLength(103);
        expect(
            result.strokes.filter((stroke: ISessionStroke): boolean => stroke.strokeRate > 0),
        ).toHaveLength(102);
        expect(
            result.strokes.filter((stroke: ISessionStroke): boolean => stroke.distPerStroke > 0),
        ).toHaveLength(102);
        expect(result.statistics.max.strokeRate).toBeCloseTo(46.4048, 3);
        expect(result.statistics.totalDistance).toBe(808.59);
        expect(result.strokes.every((stroke: ISessionStroke): boolean => stroke.recoveryDuration > 0)).toBe(
            true,
        );
        expect(result.strokes[0].forceCurve).toBeUndefined();
        expect(result.strokes[0].handleForces).toEqual([10, 89, 20]);
        expect(JSON.stringify(session)).toBe(original);
        try {
            await appDB.sessionData.bulkAdd(
                session.records.map((row: IExportRecord, index: number): IMetricsEntity => ({
                    ...row,
                    sessionId: session.sessionId,
                    timeStamp: 1_000_000 + index,
                })),
            );
            const stored = await service.loadSession(session.sessionId);
            expect(stored.statistics.max.strokeRate).toBe(result.statistics.max.strokeRate);
            expect(stored.statistics.avg.distPerStroke).toBe(result.statistics.avg.distPerStroke);
        } finally {
            await appDB.sessionData.where({ sessionId: session.sessionId }).delete();
        }
    });
});
