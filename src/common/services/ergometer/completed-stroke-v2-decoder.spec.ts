import { describe, expect, it } from "vitest";

import { decodeCompletedStrokeMetricsV2 } from "./completed-stroke-v2-decoder";

interface ITestPayloadOverrides {
    version?: number;
    flags?: number;
    strokeId?: number;
    driveDurationUs?: number;
    recoveryDurationUs?: number;
    avgStrokePowerW?: number;
    dragFactor?: number;
}

function createPayload(overrides: ITestPayloadOverrides = {}): DataView {
    const value = new DataView(new ArrayBuffer(20));
    value.setUint8(0, overrides.version ?? 2);
    value.setUint8(1, overrides.flags ?? 1);
    value.setUint16(2, overrides.strokeId ?? 0x1234, true);
    value.setUint32(4, overrides.driveDurationUs ?? 1_000_000, true);
    value.setUint32(8, overrides.recoveryDurationUs ?? 900_000, true);
    value.setFloat32(12, overrides.avgStrokePowerW ?? 243.5, true);
    value.setFloat32(16, overrides.dragFactor ?? 110.25, true);

    return value;
}

describe("decodeCompletedStrokeMetricsV2", (): void => {
    it("decodes complete metrics with stroke identity and units preserved", (): void => {
        expect(decodeCompletedStrokeMetricsV2(createPayload())).toEqual({
            strokeId: 0x1234,
            driveDurationUs: 1_000_000,
            recovery: {
                status: "complete",
                durationUs: 900_000,
                avgStrokePowerW: 243.5,
                dragFactor: 110.25,
            },
        });
    });

    it("marks incomplete recovery pending and omits its zero fields", (): void => {
        const result = decodeCompletedStrokeMetricsV2(
            createPayload({
                flags: 0,
                recoveryDurationUs: 0,
                avgStrokePowerW: 0,
                dragFactor: 0,
            }),
        );

        expect(result).toEqual({
            strokeId: 0x1234,
            driveDurationUs: 1_000_000,
            recovery: { status: "pending" },
        });
        expect(result?.recovery).not.toHaveProperty("durationUs");
        expect(result?.recovery).not.toHaveProperty("avgStrokePowerW");
        expect(result?.recovery).not.toHaveProperty("dragFactor");
    });

    it("accepts the documented broad upper bounds without clamping", (): void => {
        expect(
            decodeCompletedStrokeMetricsV2(
                createPayload({
                    driveDurationUs: 60_000_000,
                    recoveryDurationUs: 3_600_000_000,
                    avgStrokePowerW: 10_000,
                    dragFactor: 1_000,
                }),
            ),
        ).toEqual({
            strokeId: 0x1234,
            driveDurationUs: 60_000_000,
            recovery: {
                status: "complete",
                durationUs: 3_600_000_000,
                avgStrokePowerW: 10_000,
                dragFactor: 1_000,
            },
        });
    });

    it("rejects any payload length other than twenty bytes", (): void => {
        const payload = createPayload();
        expect(decodeCompletedStrokeMetricsV2(new DataView(payload.buffer, 0, 19))).toBeUndefined();

        const longer = new DataView(new ArrayBuffer(21));
        new Uint8Array(longer.buffer).set(new Uint8Array(payload.buffer));
        expect(decodeCompletedStrokeMetricsV2(longer)).toBeUndefined();
    });

    it("rejects an unsupported version and reserved flag bits", (): void => {
        expect(decodeCompletedStrokeMetricsV2(createPayload({ version: 1 }))).toBeUndefined();
        expect(decodeCompletedStrokeMetricsV2(createPayload({ flags: 0x02 }))).toBeUndefined();
        expect(decodeCompletedStrokeMetricsV2(createPayload({ flags: 0x81 }))).toBeUndefined();
    });

    it("rejects zero or implausible drive and completed recovery durations", (): void => {
        expect(decodeCompletedStrokeMetricsV2(createPayload({ driveDurationUs: 0 }))).toBeUndefined();
        expect(
            decodeCompletedStrokeMetricsV2(createPayload({ driveDurationUs: 60_000_001 })),
        ).toBeUndefined();
        expect(decodeCompletedStrokeMetricsV2(createPayload({ recoveryDurationUs: 0 }))).toBeUndefined();
        expect(
            decodeCompletedStrokeMetricsV2(createPayload({ recoveryDurationUs: 3_600_000_001 })),
        ).toBeUndefined();
    });

    it("rejects non-finite completed float fields", (): void => {
        expect(
            decodeCompletedStrokeMetricsV2(createPayload({ avgStrokePowerW: Number.NaN })),
        ).toBeUndefined();
        expect(
            decodeCompletedStrokeMetricsV2(createPayload({ avgStrokePowerW: Number.POSITIVE_INFINITY })),
        ).toBeUndefined();
        expect(decodeCompletedStrokeMetricsV2(createPayload({ dragFactor: Number.NaN }))).toBeUndefined();
        expect(
            decodeCompletedStrokeMetricsV2(createPayload({ dragFactor: Number.NEGATIVE_INFINITY })),
        ).toBeUndefined();
    });

    it("ignores recovery placeholders until the completion flag is set", (): void => {
        expect(
            decodeCompletedStrokeMetricsV2(
                createPayload({ flags: 0, recoveryDurationUs: 0, avgStrokePowerW: Number.NaN }),
            ),
        ).toEqual({ strokeId: 0x1234, driveDurationUs: 1_000_000, recovery: { status: "pending" } });
    });

    it("rejects negative and implausibly high power and drag values", (): void => {
        expect(decodeCompletedStrokeMetricsV2(createPayload({ avgStrokePowerW: -1 }))).toBeUndefined();
        expect(decodeCompletedStrokeMetricsV2(createPayload({ avgStrokePowerW: 10_001 }))).toBeUndefined();
        expect(decodeCompletedStrokeMetricsV2(createPayload({ dragFactor: -1 }))).toBeUndefined();
        expect(decodeCompletedStrokeMetricsV2(createPayload({ dragFactor: 1_001 }))).toBeUndefined();
    });
});
