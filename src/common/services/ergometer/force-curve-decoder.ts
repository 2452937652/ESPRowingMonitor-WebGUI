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

    reset(): void {
        this.curve = undefined;
        this.fragments = undefined;
        this.fragmentOffset = 0;
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
        if (offset === 0) {
            this.reset();
            this.fragments = new Uint8Array(size);
            this.fragmentStroke = stroke;
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
        this.fragments.set(new Uint8Array(value.buffer, value.byteOffset + 8, count), offset);
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
        this.nextChunk++;
        if (index !== chunks) return undefined;
        this.curve = undefined;

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
}
