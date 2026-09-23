import { describe, expect, it } from "vitest";

import { IForceCurvePoint } from "../../common.interfaces";

import { ForceCurveDecoder } from "./force-curve-decoder";

const samples: Array<IForceCurvePoint> = [
    { distance: 0, elapsedTime: 0, force: 10 },
    { distance: 0.7, elapsedTime: 0.6, force: 90 },
    { distance: 1.4, elapsedTime: 1.2, force: 0 },
];

describe("ForceCurveDecoder", (): void => {
    it("accepts a duplicated sample packet without producing a second or lost curve", (): void => {
        const decoder = new ForceCurveDecoder();
        const first = samplePacket(2, 1, 42, samples.length, samples.slice(0, 2));
        const second = samplePacket(2, 2, 42, samples.length, samples.slice(2));

        expect(decoder.accept(asDataView(first))).toBeUndefined();
        expect(decoder.accept(asDataView(first))).toBeUndefined();
        expectCurve(decoder.accept(asDataView(second)), 42);
    });

    it("does not complete a curve with a missing packet and recovers when a fresh first packet arrives", (): void => {
        const decoder = new ForceCurveDecoder();
        const first = samplePacket(3, 1, 43, samples.length, samples.slice(0, 1));
        const second = samplePacket(3, 2, 43, samples.length, samples.slice(1, 2));
        const third = samplePacket(3, 3, 43, samples.length, samples.slice(2));

        expect(decoder.accept(asDataView(first))).toBeUndefined();
        expect(decoder.accept(asDataView(third))).toBeUndefined();
        expect(decoder.accept(asDataView(first))).toBeUndefined();
        expect(decoder.accept(asDataView(second))).toBeUndefined();
        expectCurve(decoder.accept(asDataView(third)), 43);
    });

    it("accepts a repeated BLE fragment while retaining the original assembly progress", (): void => {
        const decoder = new ForceCurveDecoder();
        const packet = samplePacket(1, 1, 44, samples.length, samples);
        const firstPayload = packet.slice(0, 12);
        const secondPayload = packet.slice(12);
        const first = fragmentPacket(44, packet.length, 0, firstPayload);
        const second = fragmentPacket(44, packet.length, firstPayload.length, secondPayload);

        expect(decoder.accept(asDataView(first))).toBeUndefined();
        expect(decoder.accept(asDataView(first))).toBeUndefined();
        expectCurve(decoder.accept(asDataView(second)), 44);
    });

    it("clears partial transport state on reconnect and will not splice old and new packets", (): void => {
        const decoder = new ForceCurveDecoder();
        const first = samplePacket(2, 1, 45, samples.length, samples.slice(0, 2));
        const second = samplePacket(2, 2, 45, samples.length, samples.slice(2));

        expect(decoder.accept(asDataView(first))).toBeUndefined();
        decoder.reset();
        expect(decoder.accept(asDataView(second))).toBeUndefined();
        expect(decoder.accept(asDataView(first))).toBeUndefined();
        expectCurve(decoder.accept(asDataView(second)), 45);
    });

    it("suppresses a repeated complete one-packet curve", (): void => {
        const decoder = new ForceCurveDecoder();
        const packet = samplePacket(1, 1, 46, samples.length, samples);

        expectCurve(decoder.accept(asDataView(packet)), 46);
        expect(decoder.accept(asDataView(packet))).toBeUndefined();
    });
});

function samplePacket(
    chunks: number,
    index: number,
    strokeId: number,
    totalSampleCount: number,
    points: Array<IForceCurvePoint>,
): Uint8Array {
    const bytes = new Uint8Array(16 + points.length * 12);
    const view = asDataView(bytes);
    view.setUint8(0, 1);
    view.setUint8(1, chunks);
    view.setUint8(2, index);
    view.setUint8(3, 0);
    view.setUint16(4, strokeId, true);
    view.setUint16(6, totalSampleCount, true);
    view.setFloat32(8, 1.4, true);
    view.setUint32(12, 1_200_000, true);
    points.forEach((point: IForceCurvePoint, index: number): void => {
        const offset = 16 + index * 12;
        view.setFloat32(offset, point.distance, true);
        view.setUint32(offset + 4, Math.round(point.elapsedTime * 1e6), true);
        view.setFloat32(offset + 8, point.force, true);
    });

    return bytes;
}

function fragmentPacket(strokeId: number, fullLength: number, offset: number, payload: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(8 + payload.length);
    const view = asDataView(bytes);
    view.setUint8(0, 2);
    view.setUint8(1, 0);
    view.setUint16(2, strokeId, true);
    view.setUint16(4, fullLength, true);
    view.setUint16(6, offset, true);
    bytes.set(payload, 8);

    return bytes;
}

function asDataView(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function expectCurve(
    curve: ReturnType<ForceCurveDecoder["accept"]>,
    strokeId: number,
): void {
    expect(curve?.strokeId).toBe(strokeId);
    expect(curve?.driveLength).toBeCloseTo(1.4, 5);
    expect(curve?.driveDuration).toBeCloseTo(1.2, 5);
    expect(curve?.samples).toHaveLength(samples.length);
    curve?.samples.forEach((sample: IForceCurvePoint, index: number): void => {
        expect(sample.distance).toBeCloseTo(samples[index].distance, 5);
        expect(sample.elapsedTime).toBeCloseTo(samples[index].elapsedTime, 5);
        expect(sample.force).toBeCloseTo(samples[index].force, 5);
    });
}
