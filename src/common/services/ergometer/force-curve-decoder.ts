import { IForceCurve, IForceCurvePoint } from "../../common.interfaces";

/** One bounded, ordered stroke at a time; a new first packet abandons a lost stroke. */
export class ForceCurveDecoder {
    private curve: IForceCurve | undefined;
    private nextChunk: number = 1;
    private chunks: number = 0;
    private sampleCount: number = 0;
    private fragments: Uint8Array | undefined;
    private fragmentOffset: number = 0;
    private fragmentStroke: number = 0;
    private lastPacketAt: number = 0;
    private lastAcceptedSamplePacket: Uint8Array | undefined;
    private lastCompletedSamplePacket: Uint8Array | undefined;
    private lastCompletedStroke: number | undefined;

    reset(): void {
        this.curve = undefined;
        this.nextChunk = 1;
        this.chunks = 0;
        this.sampleCount = 0;
        this.fragments = undefined;
        this.fragmentOffset = 0;
        this.fragmentStroke = 0;
        this.lastAcceptedSamplePacket = undefined;
        this.lastCompletedSamplePacket = undefined;
        this.lastCompletedStroke = undefined;
    }

    accept(value: DataView, now: number = Date.now()): IForceCurve | undefined {
        if (now - this.lastPacketAt > 5000) this.reset();
        this.lastPacketAt = now;
        if (value.byteLength === 0) return undefined;
        if (value.getUint8(0) === 2) return this.acceptFragment(value);
        this.fragments = undefined;

        return this.acceptSamples(value);
    }

    private acceptFragment(value: DataView): IForceCurve | undefined {
        // version 2 envelope: version, reserved, strokeId, byteLength, byteOffset.
        if (value.byteLength <= 8 || value.getUint8(1) !== 0) {
            this.reset();

            return undefined;
        }
        const stroke = value.getUint16(2, true);
        const size = value.getUint16(4, true);
        const offset = value.getUint16(6, true);
        const count = value.byteLength - 8;
        if (size < 28 || size > 16 + 255 * 12 || (size - 16) % 12 !== 0 || offset + count > size) {
            this.reset();

            return undefined;
        }
        const payload = new Uint8Array(value.buffer, value.byteOffset + 8, count);
        if (offset === 0) {
            if (
                this.fragments !== undefined &&
                this.fragments.length === size &&
                stroke === this.fragmentStroke &&
                this.fragmentOffset >= count &&
                this.isSameBytes(this.fragments.subarray(0, count), payload)
            ) {
                // BLE retransmission of the first fragment: retain the
                // already assembled prefix rather than throwing it away.
                return undefined;
            }
            this.reset();
            this.fragments = new Uint8Array(size);
            this.fragmentStroke = stroke;
        }
        if (
            this.fragments !== undefined &&
            this.fragments.length === size &&
            stroke === this.fragmentStroke &&
            offset < this.fragmentOffset &&
            offset + count <= this.fragmentOffset &&
            this.isSameBytes(this.fragments.subarray(offset, offset + count), payload)
        ) {
            // A repeated already-accepted fragment is harmless. Do not allow
            // it to make an otherwise complete curve look like a gap.
            return undefined;
        }
        if (
            !this.fragments ||
            this.fragments.length !== size ||
            stroke !== this.fragmentStroke ||
            offset !== this.fragmentOffset
        ) {
            this.reset();

            return undefined;
        }
        this.fragments.set(payload, offset);
        this.fragmentOffset += count;
        if (this.fragmentOffset !== size) return undefined;
        const packet = new DataView(this.fragments.buffer);
        this.fragments = undefined;
        if (packet.getUint16(4, true) !== stroke || packet.getUint8(1) !== 1 || packet.getUint8(2) !== 1) {
            this.reset();

            return undefined;
        }

        return this.acceptSamples(packet);
    }

    private acceptSamples(value: DataView): IForceCurve | undefined {
        if (value.byteLength < 28 || (value.byteLength - 16) % 12 !== 0 || value.getUint8(0) !== 1) {
            this.reset();

            return undefined;
        }
        const chunks = value.getUint8(1);
        const index = value.getUint8(2);
        const strokeId = value.getUint16(4, true);
        const count = value.getUint16(6, true);
        const driveLength = value.getFloat32(8, true);
        const driveDuration = value.getUint32(12, true) / 1e6;
        if (!this.isValidHeader(value)) {
            this.reset();

            return undefined;
        }
        const packet = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (
            this.curve === undefined &&
            this.lastCompletedStroke === strokeId &&
            this.lastCompletedSamplePacket !== undefined &&
            this.isSameBytes(this.lastCompletedSamplePacket, packet)
        ) {
            // A complete one-packet curve can be repeated by a BLE notifier.
            // The stroke assembler is idempotent too, but suppress it here to
            // avoid an unnecessary UI/persistence update.
            return undefined;
        }
        if (
            this.curve !== undefined &&
            index === this.nextChunk - 1 &&
            this.lastAcceptedSamplePacket !== undefined &&
            this.isSameBytes(this.lastAcceptedSamplePacket, packet)
        ) {
            return undefined;
        }
        if (index === 1) {
            this.curve = { strokeId, driveLength, driveDuration, samples: [] };
            this.nextChunk = 1;
            this.chunks = chunks;
            this.sampleCount = count;
        }
        const curve = this.curve;
        if (
            !curve ||
            curve.strokeId !== strokeId ||
            index !== this.nextChunk ||
            chunks !== this.chunks ||
            count !== this.sampleCount ||
            driveLength !== curve.driveLength ||
            driveDuration !== curve.driveDuration
        ) {
            this.reset();

            return undefined;
        }
        for (let offset = 16; offset < value.byteLength; offset += 12) {
            const sample = {
                distance: value.getFloat32(offset, true),
                elapsedTime: value.getUint32(offset + 4, true) / 1e6,
                force: value.getFloat32(offset + 8, true),
            };
            if (!this.isValidSample(sample, curve) || curve.samples.length >= count) {
                this.reset();

                return undefined;
            }
            curve.samples.push(sample);
        }
        this.lastAcceptedSamplePacket = packet.slice();
        this.nextChunk++;
        if (index !== chunks) return undefined;
        this.curve = undefined;
        this.lastCompletedStroke = strokeId;
        this.lastCompletedSamplePacket = packet.slice();

        return curve.samples.length === count ? curve : undefined;
    }

    private isValidHeader(value: DataView): boolean {
        const chunks = value.getUint8(1);
        const index = value.getUint8(2);
        const count = value.getUint16(6, true);
        const length = value.getFloat32(8, true);

        return (
            chunks > 0 &&
            index > 0 &&
            index <= chunks &&
            count > 0 &&
            count <= 255 &&
            Number.isFinite(length) &&
            length >= 0 &&
            value.getUint8(3) === 0
        );
    }

    private isValidSample(sample: IForceCurvePoint, curve: IForceCurve): boolean {
        const previous = curve.samples.at(-1);

        return (
            Number.isFinite(sample.distance) &&
            Number.isFinite(sample.force) &&
            sample.distance >= 0 &&
            sample.distance <= curve.driveLength + 0.0001 &&
            sample.elapsedTime <= curve.driveDuration + 0.000001 &&
            (previous === undefined ||
                (sample.distance >= previous.distance && sample.elapsedTime >= previous.elapsedTime))
        );
    }

    private isSameBytes(first: Uint8Array, second: Uint8Array): boolean {
        if (first.length !== second.length) {
            return false;
        }

        return first.every((value: number, index: number): boolean => value === second[index]);
    }
}
