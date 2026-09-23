import { describe, expect, it } from "vitest";

import {
    IPhysicalForceCurveV2,
    IPhysicalForceCurveV2Point,
    PhysicalForceCurveV2Decoder,
} from "./physical-force-curve-v2-decoder";

const HEADER_LENGTH = 16;
const SAMPLE_LENGTH = 12;

function createCurve(sampleCount: number = 128, strokeId: number = 42): IPhysicalForceCurveV2 {
    return {
        strokeId,
        driveLength: 1.5,
        driveDurationUs: 2_000_000,
        samples: Array.from(
            { length: sampleCount },
            (_: undefined, index: number): IPhysicalForceCurveV2Point => ({
                distance: index * 0.01,
                elapsedTimeUs: index * 10_000,
                force: 15 + index * 0.25,
            }),
        ),
    };
}

function expectedDecodedCurve(curve: IPhysicalForceCurveV2): IPhysicalForceCurveV2 {
    return {
        strokeId: curve.strokeId,
        driveLength: Math.fround(curve.driveLength),
        driveDurationUs: curve.driveDurationUs,
        samples: curve.samples.map((sample: IPhysicalForceCurveV2Point): IPhysicalForceCurveV2Point => ({
            distance: Math.fround(sample.distance),
            elapsedTimeUs: sample.elapsedTimeUs,
            force: Math.fround(sample.force),
        })),
    };
}

function createChunk(
    curve: IPhysicalForceCurveV2,
    chunkCount: number,
    chunkIndex: number,
    firstSample: number,
    endSample: number,
): DataView {
    const sampleCountInPacket = endSample - firstSample;
    const value = new DataView(new ArrayBuffer(HEADER_LENGTH + sampleCountInPacket * SAMPLE_LENGTH));
    value.setUint8(0, 2);
    value.setUint8(1, chunkCount);
    value.setUint8(2, chunkIndex);
    value.setUint8(3, 0);
    value.setUint16(4, curve.strokeId, true);
    value.setUint16(6, curve.samples.length, true);
    value.setFloat32(8, curve.driveLength, true);
    value.setUint32(12, curve.driveDurationUs, true);

    for (let index = firstSample; index < endSample; index++) {
        const sample = curve.samples[index];
        const offset = HEADER_LENGTH + (index - firstSample) * SAMPLE_LENGTH;
        value.setFloat32(offset, sample.distance, true);
        value.setUint32(offset + 4, sample.elapsedTimeUs, true);
        value.setFloat32(offset + 8, sample.force, true);
    }

    return value;
}

function createDirectChunks(curve: IPhysicalForceCurveV2, mtu: number): Array<DataView> {
    const maximumSamplesPerChunk = Math.floor((mtu - 3 - HEADER_LENGTH) / SAMPLE_LENGTH);
    const chunkCount = Math.ceil(curve.samples.length / maximumSamplesPerChunk);
    const chunks: Array<DataView> = [];

    for (let chunkIndex = 1; chunkIndex <= chunkCount; chunkIndex++) {
        const firstSample = (chunkIndex - 1) * maximumSamplesPerChunk;
        const endSample = Math.min(firstSample + maximumSamplesPerChunk, curve.samples.length);
        chunks.push(createChunk(curve, chunkCount, chunkIndex, firstSample, endSample));
    }

    return chunks;
}

function createSingleFrame(curve: IPhysicalForceCurveV2): DataView {
    return createChunk(curve, 1, 1, 0, curve.samples.length);
}

function createFragments(frame: DataView, mtu: number, envelopeStrokeId?: number): Array<DataView> {
    const fragmentCapacity = mtu - 3 - 8;
    const frameBytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    const fragments: Array<DataView> = [];
    for (let offset = 0; offset < frame.byteLength; offset += fragmentCapacity) {
        const payload = frameBytes.slice(offset, Math.min(offset + fragmentCapacity, frame.byteLength));
        const value = new DataView(new ArrayBuffer(8 + payload.length));
        value.setUint8(0, 0xf2);
        value.setUint8(1, 2);
        value.setUint16(2, envelopeStrokeId ?? frame.getUint16(4, true), true);
        value.setUint16(4, frame.byteLength, true);
        value.setUint16(6, offset, true);
        new Uint8Array(value.buffer, 8, payload.length).set(payload);
        fragments.push(value);
    }

    return fragments;
}

function collectAccepted(
    decoder: PhysicalForceCurveV2Decoder,
    notifications: Array<DataView>,
): Array<IPhysicalForceCurveV2> {
    return notifications.reduce(
        (curves: Array<IPhysicalForceCurveV2>, notification: DataView): Array<IPhysicalForceCurveV2> => {
            const curve = decoder.accept(notification);
            if (curve !== undefined) {
                curves.push(curve);
            }

            return curves;
        },
        [],
    );
}

describe("PhysicalForceCurveV2Decoder", (): void => {
    for (const mtu of [23, 30, 31, 185, 247, 512]) {
        it(`reassembles a validated curve exactly once at MTU ${mtu}`, (): void => {
            const curve = createCurve();
            const packets =
                mtu < 31 ? createFragments(createSingleFrame(curve), mtu) : createDirectChunks(curve, mtu);
            const decoder = new PhysicalForceCurveV2Decoder();

            expect(packets.every((packet: DataView): boolean => packet.byteLength <= mtu - 3)).toBe(true);
            expect(collectAccepted(decoder, packets)).toEqual([expectedDecodedCurve(curve)]);
            expect(collectAccepted(decoder, packets)).toEqual([]);
        });
    }

    it("treats repeated chunks as idempotent and emits after ordered chunks arrive", (): void => {
        const curve = createCurve(3, 101);
        const chunks = [
            createChunk(curve, 3, 1, 0, 1),
            createChunk(curve, 3, 2, 1, 2),
            createChunk(curve, 3, 3, 2, 3),
        ];
        const decoder = new PhysicalForceCurveV2Decoder();

        expect(decoder.accept(chunks[0])).toBeUndefined();
        expect(decoder.accept(chunks[0])).toBeUndefined();
        expect(decoder.accept(chunks[1])).toBeUndefined();
        expect(decoder.accept(chunks[1])).toBeUndefined();
        expect(decoder.accept(chunks[2])).toEqual(expectedDecodedCurve(curve));
        expect(decoder.accept(chunks[2])).toBeUndefined();
    });

    it("discards a transfer with a missing or out-of-order chunk", (): void => {
        const curve = createCurve(3, 102);
        const chunks = [
            createChunk(curve, 3, 1, 0, 1),
            createChunk(curve, 3, 2, 1, 2),
            createChunk(curve, 3, 3, 2, 3),
        ];
        const decoder = new PhysicalForceCurveV2Decoder();

        expect(decoder.accept(chunks[0])).toBeUndefined();
        expect(decoder.accept(chunks[2])).toBeUndefined();
        expect(decoder.accept(chunks[1])).toBeUndefined();
        expect(decoder.accept(chunks[2])).toBeUndefined();

        expect(decoder.accept(chunks[0])).toBeUndefined();
        expect(decoder.accept(chunks[1])).toBeUndefined();
        expect(decoder.accept(chunks[2])).toEqual(expectedDecodedCurve(curve));
    });

    it("abandons an incomplete stroke when the first chunk of a new stroke arrives", (): void => {
        const strokeA = createCurve(2, 200);
        const strokeB = createCurve(2, 201);
        const firstA = createChunk(strokeA, 2, 1, 0, 1);
        const secondA = createChunk(strokeA, 2, 2, 1, 2);
        const firstB = createChunk(strokeB, 2, 1, 0, 1);
        const secondB = createChunk(strokeB, 2, 2, 1, 2);
        const decoder = new PhysicalForceCurveV2Decoder();

        expect(decoder.accept(firstA)).toBeUndefined();
        expect(decoder.accept(firstB)).toBeUndefined();
        expect(decoder.accept(secondA)).toBeUndefined();
        expect(decoder.accept(firstB)).toBeUndefined();
        expect(decoder.accept(secondB)).toEqual(expectedDecodedCurve(strokeB));
    });

    it("rejects chunk packets from another stroke and requires a fresh first chunk", (): void => {
        const strokeA = createCurve(2, 210);
        const strokeB = createCurve(2, 211);
        const decoder = new PhysicalForceCurveV2Decoder();

        expect(decoder.accept(createChunk(strokeA, 2, 1, 0, 1))).toBeUndefined();
        expect(decoder.accept(createChunk(strokeB, 2, 2, 1, 2))).toBeUndefined();
        expect(decoder.accept(createChunk(strokeB, 2, 1, 0, 1))).toBeUndefined();
        expect(decoder.accept(createChunk(strokeB, 2, 2, 1, 2))).toEqual(expectedDecodedCurve(strokeB));
    });

    it("drops incomplete direct chunks after five seconds", (): void => {
        const curve = createCurve(2, 301);
        const first = createChunk(curve, 2, 1, 0, 1);
        const second = createChunk(curve, 2, 2, 1, 2);
        const decoder = new PhysicalForceCurveV2Decoder();

        expect(decoder.accept(first, 100)).toBeUndefined();
        expect(decoder.accept(second, 5101)).toBeUndefined();
        expect(decoder.accept(first, 5102)).toBeUndefined();
        expect(decoder.accept(second, 5103)).toEqual(expectedDecodedCurve(curve));
    });

    it("drops malformed headers, lengths, counts, flags, and non-monotonic samples", (): void => {
        const curve = createCurve(3, 400);
        const malformed: Array<DataView> = [];

        const shortPacket = createChunk(curve, 1, 1, 0, 2);
        malformed.push(new DataView(shortPacket.buffer, shortPacket.byteOffset, shortPacket.byteLength - 1));

        const wrongVersion = createChunk(curve, 1, 1, 0, 2);
        wrongVersion.setUint8(0, 1);
        malformed.push(wrongVersion);

        const reservedFlags = createChunk(curve, 1, 1, 0, 2);
        reservedFlags.setUint8(3, 1);
        malformed.push(reservedFlags);

        const zeroChunks = createChunk(curve, 1, 1, 0, 2);
        zeroChunks.setUint8(1, 0);
        malformed.push(zeroChunks);

        const tooManySamples = createChunk(curve, 1, 1, 0, 2);
        tooManySamples.setUint16(6, 129, true);
        malformed.push(tooManySamples);

        const nonFiniteLength = createChunk(curve, 1, 1, 0, 2);
        nonFiniteLength.setFloat32(8, Number.NaN, true);
        malformed.push(nonFiniteLength);

        const nonMonotonic = createChunk(curve, 1, 1, 0, 3);
        nonMonotonic.setFloat32(HEADER_LENGTH + 2 * SAMPLE_LENGTH, 0.005, true);
        nonMonotonic.setUint32(HEADER_LENGTH + 2 * SAMPLE_LENGTH + 4, 15_000, true);
        malformed.push(nonMonotonic);

        malformed.forEach((packet: DataView): void => {
            expect(new PhysicalForceCurveV2Decoder().accept(packet)).toBeUndefined();
        });
    });

    it("rejects samples outside drive bounds and total sample-count mismatches", (): void => {
        const curve = createCurve(2, 401);
        const beyondDrive = createChunk(curve, 1, 1, 0, 2);
        beyondDrive.setFloat32(HEADER_LENGTH + SAMPLE_LENGTH, curve.driveLength + 0.1, true);
        expect(new PhysicalForceCurveV2Decoder().accept(beyondDrive)).toBeUndefined();

        const countMismatch = createChunk(curve, 1, 1, 0, 1);
        expect(new PhysicalForceCurveV2Decoder().accept(countMismatch)).toBeUndefined();
    });

    it("rejects fragment gaps, overlaps, and fragments for a different stroke", (): void => {
        const curve = createCurve(10, 500);
        const fragments = createFragments(createSingleFrame(curve), 23);
        const decoder = new PhysicalForceCurveV2Decoder();

        expect(decoder.accept(fragments[0])).toBeUndefined();
        expect(decoder.accept(fragments[2])).toBeUndefined();
        expect(collectAccepted(decoder, fragments.slice(1))).toEqual([]);

        const otherStrokeFragments = createFragments(createSingleFrame(createCurve(10, 501)), 23);
        expect(decoder.accept(fragments[0])).toBeUndefined();
        expect(decoder.accept(otherStrokeFragments[1])).toBeUndefined();
        expect(collectAccepted(decoder, otherStrokeFragments.slice(2))).toEqual([]);
        expect(collectAccepted(decoder, otherStrokeFragments)).toEqual([
            expectedDecodedCurve(createCurve(10, 501)),
        ]);
    });

    it("checks envelope stroke identity against the reassembled frame", (): void => {
        const curve = createCurve(10, 510);
        const fragments = createFragments(createSingleFrame(curve), 23, curve.strokeId + 1);
        const decoder = new PhysicalForceCurveV2Decoder();

        expect(collectAccepted(decoder, fragments)).toEqual([]);
    });

    it("drops incomplete low-MTU fragments after five seconds", (): void => {
        const curve = createCurve(10, 520);
        const fragments = createFragments(createSingleFrame(curve), 23);
        const decoder = new PhysicalForceCurveV2Decoder();

        expect(decoder.accept(fragments[0], 100)).toBeUndefined();
        expect(decoder.accept(fragments[1], 5101)).toBeUndefined();
        expect(collectAccepted(decoder, fragments.slice(2))).toEqual([]);
        expect(collectAccepted(decoder, fragments)).toEqual([expectedDecodedCurve(curve)]);
    });

    it("rejects fragment packets larger than the MTU 30 envelope limit", (): void => {
        const curve = createCurve(1, 530);
        const fragment = createFragments(createSingleFrame(curve), 30)[0];
        const oversized = new DataView(new ArrayBuffer(28));
        oversized.setUint8(0, 0xf2);
        oversized.setUint8(1, 2);
        oversized.setUint16(2, curve.strokeId, true);
        oversized.setUint16(4, HEADER_LENGTH + SAMPLE_LENGTH, true);
        oversized.setUint16(6, 0, true);

        expect(fragment.byteLength).toBeLessThanOrEqual(27);
        expect(new PhysicalForceCurveV2Decoder().accept(oversized)).toBeUndefined();
    });
});
