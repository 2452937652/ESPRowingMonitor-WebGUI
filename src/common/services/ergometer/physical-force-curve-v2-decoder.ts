/** One decoded point in the independent Physical Force Curve V2 protocol. */
export interface IPhysicalForceCurveV2Point {
    /** Distance from the start of the drive, in metres. */
    distance: number;
    /** Elapsed time from the start of the drive, in microseconds. */
    elapsedTimeUs: number;
    /** Handle force, in newtons. */
    force: number;
}

/** A complete, validated Physical Force Curve V2 for one stroke. */
export interface IPhysicalForceCurveV2 {
    strokeId: number;
    /** Drive length, in metres. */
    driveLength: number;
    /** Drive duration, in microseconds. */
    driveDurationUs: number;
    samples: Array<IPhysicalForceCurveV2Point>;
}

interface IChunkHeader {
    chunkCount: number;
    chunkIndex: number;
    strokeId: number;
    sampleCount: number;
    driveLength: number;
    driveDurationUs: number;
    samplesInPacket: number;
}

interface IChunkAssembly {
    header: IChunkHeader;
    nextChunkIndex: number;
    samples: Array<IPhysicalForceCurveV2Point>;
    packets: Map<number, Uint8Array>;
}

interface IFragmentAssembly {
    strokeId: number;
    frameLength: number;
    bytes: Uint8Array;
    nextOffset: number;
    fragments: Map<number, Uint8Array>;
}

interface IFragmentHeader {
    strokeId: number;
    frameLength: number;
    offset: number;
    fragmentLength: number;
}

interface ICompletedTransfer {
    strokeId: number;
    packets: Map<number, Uint8Array>;
}

const HEADER_LENGTH = 16;
const SAMPLE_LENGTH = 12;
const MAX_SAMPLE_COUNT = 128;
const FRAGMENT_HEADER_LENGTH = 8;
const FRAGMENT_MARKER = 0xf2;
const FRAGMENT_VERSION = 2;
const MAX_FRAGMENT_PACKET_LENGTH = 27; // mtu 30 minus ATT and envelope headers.
const INCOMPLETE_TIMEOUT_MS = 5000;

/**
 * reassembles and validates Physical Force Curve V2 notifications.
 *
 * This decoder is deliberately independent of BLE discovery and the legacy
 * handle-force characteristic. Call reset() when the owning BLE connection or
 * source epoch changes.
 */
export class PhysicalForceCurveV2Decoder {
    private chunkAssembly: IChunkAssembly | undefined;
    private fragmentAssembly: IFragmentAssembly | undefined;
    private lastAcceptedAt: number | undefined;
    private lastCompleted: ICompletedTransfer | undefined;

    reset(): void {
        this.clearPending();
        this.lastCompleted = undefined;
    }

    /**
     * Accept one notification. Incomplete, malformed, duplicate, or rejected
     * notifications return undefined. `now` is injectable for deterministic
     * timeout tests.
     */
    accept(value: DataView, now: number = Date.now()): IPhysicalForceCurveV2 | undefined {
        this.expireIncompleteTransfer(now);
        if (value.byteLength === 0) {
            this.clearPending();

            return undefined;
        }

        const marker = value.getUint8(0);
        if (marker === FRAGMENT_MARKER) {
            return this.acceptFragment(value, now);
        }

        if (marker === 2) {
            // direct chunk notifications and low-MTU fragments are alternate
            // transports for the same logical curve; never combine their state.
            if (this.fragmentAssembly !== undefined) {
                this.clearPending();
            }

            return this.acceptChunk(value, now);
        }

        this.clearPending();

        return undefined;
    }

    private acceptFragment(value: DataView, now: number): IPhysicalForceCurveV2 | undefined {
        const header = this.readFragmentHeader(value);
        if (header === undefined) {
            return this.rejectPending();
        }

        const payload = new Uint8Array(
            value.buffer,
            value.byteOffset + FRAGMENT_HEADER_LENGTH,
            header.fragmentLength,
        ).slice();
        if (header.offset === 0) {
            const startResult = this.startFragmentAssembly(header, payload, now);
            if (startResult !== "started") {
                return undefined;
            }
        }

        const assembly = this.fragmentAssembly;
        if (!this.matchesFragmentAssembly(assembly, header)) {
            return this.rejectPending();
        }

        if (header.offset < assembly.nextOffset) {
            if (this.isDuplicateFragment(assembly, header.offset, payload, now)) {
                return undefined;
            }

            return this.rejectPending();
        }

        if (header.offset !== assembly.nextOffset) {
            return this.rejectPending();
        }

        assembly.bytes.set(payload, header.offset);
        assembly.fragments.set(header.offset, payload);
        assembly.nextOffset += header.fragmentLength;
        this.lastAcceptedAt = now;
        if (assembly.nextOffset !== header.frameLength) {
            return undefined;
        }

        const assembledFrame = new DataView(assembly.bytes.buffer);
        const assembledStrokeId = assembly.strokeId;
        this.clearPending();
        if (!this.isSingleFrame(assembledFrame, assembledStrokeId)) {
            return undefined;
        }

        return this.acceptChunk(assembledFrame, now);
    }

    private readFragmentHeader(value: DataView): IFragmentHeader | undefined {
        if (
            value.byteLength <= FRAGMENT_HEADER_LENGTH ||
            value.byteLength > MAX_FRAGMENT_PACKET_LENGTH ||
            value.getUint8(1) !== FRAGMENT_VERSION
        ) {
            return undefined;
        }

        const frameLength = value.getUint16(4, true);
        const offset = value.getUint16(6, true);
        const fragmentLength = value.byteLength - FRAGMENT_HEADER_LENGTH;
        if (
            frameLength < HEADER_LENGTH + SAMPLE_LENGTH ||
            frameLength > HEADER_LENGTH + MAX_SAMPLE_COUNT * SAMPLE_LENGTH ||
            (frameLength - HEADER_LENGTH) % SAMPLE_LENGTH !== 0 ||
            offset + fragmentLength > frameLength
        ) {
            return undefined;
        }

        return {
            strokeId: value.getUint16(2, true),
            frameLength,
            offset,
            fragmentLength,
        };
    }

    private startFragmentAssembly(
        header: IFragmentHeader,
        payload: Uint8Array,
        now: number,
    ): "started" | "duplicate" | "rejected" {
        const current = this.fragmentAssembly;
        if (current?.strokeId === header.strokeId) {
            const previousFirstFragment = current.fragments.get(0);
            if (
                current.frameLength === header.frameLength &&
                previousFirstFragment !== undefined &&
                this.sameBytes(previousFirstFragment, payload)
            ) {
                this.lastAcceptedAt = now;

                return "duplicate";
            }

            // a same-stroke offset-zero packet with different bytes conflicts
            // with the immutable frame already being received.
            this.clearPending();

            return "rejected";
        }

        // the first fragment of a new stroke abandons any incomplete transfer.
        this.clearPending();
        this.fragmentAssembly = {
            strokeId: header.strokeId,
            frameLength: header.frameLength,
            bytes: new Uint8Array(header.frameLength),
            nextOffset: 0,
            fragments: new Map<number, Uint8Array>(),
        };

        return "started";
    }

    private matchesFragmentAssembly(
        assembly: IFragmentAssembly | undefined,
        header: IFragmentHeader,
    ): assembly is IFragmentAssembly {
        return (
            assembly !== undefined &&
            assembly.strokeId === header.strokeId &&
            assembly.frameLength === header.frameLength
        );
    }

    private isDuplicateFragment(
        assembly: IFragmentAssembly,
        offset: number,
        payload: Uint8Array,
        now: number,
    ): boolean {
        const previous = assembly.fragments.get(offset);
        if (previous === undefined || !this.sameBytes(previous, payload)) {
            return false;
        }

        this.lastAcceptedAt = now;

        return true;
    }

    private isSingleFrame(value: DataView, strokeId: number): boolean {
        const header = this.readChunkHeader(value);

        return (
            header !== undefined &&
            header.strokeId === strokeId &&
            header.chunkCount === 1 &&
            header.chunkIndex === 1 &&
            value.byteLength === HEADER_LENGTH + header.sampleCount * SAMPLE_LENGTH
        );
    }

    private acceptChunk(value: DataView, now: number): IPhysicalForceCurveV2 | undefined {
        const header = this.readChunkHeader(value);
        if (header === undefined) {
            return this.rejectPending();
        }

        const packet = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
        if (this.lastCompleted?.strokeId === header.strokeId) {
            const completedPacket = this.lastCompleted.packets.get(header.chunkIndex);
            if (completedPacket !== undefined && !this.sameBytes(completedPacket, packet)) {
                this.clearPending();
            }

            // a stroke is immutable, so completed-stroke packets are suppressed.
            return undefined;
        }

        const assembly = this.prepareChunkAssembly(header, packet, now);
        if (assembly === undefined) {
            return undefined;
        }

        if (!this.appendChunkSamples(value, header, assembly)) {
            return this.rejectPending();
        }

        assembly.packets.set(header.chunkIndex, packet);
        assembly.nextChunkIndex++;
        this.lastAcceptedAt = now;
        if (header.chunkIndex !== header.chunkCount) {
            return undefined;
        }

        return this.completeChunkAssembly(header, assembly);
    }

    private prepareChunkAssembly(
        header: IChunkHeader,
        packet: Uint8Array,
        now: number,
    ): IChunkAssembly | undefined {
        let assembly = this.chunkAssembly;
        if (header.chunkIndex === 1) {
            if (assembly?.header.strokeId === header.strokeId) {
                const acceptedFirstChunk = assembly.packets.get(1);
                if (acceptedFirstChunk !== undefined && this.sameBytes(acceptedFirstChunk, packet)) {
                    this.lastAcceptedAt = now;

                    return undefined;
                }

                this.clearPending();

                return undefined;
            }

            if (assembly !== undefined) {
                this.clearPending();
            }

            assembly = {
                header,
                nextChunkIndex: 1,
                samples: [],
                packets: new Map<number, Uint8Array>(),
            };
            this.chunkAssembly = assembly;
        }

        if (assembly === undefined || assembly.header.strokeId !== header.strokeId) {
            this.clearPending();

            return undefined;
        }

        const previousPacket = assembly.packets.get(header.chunkIndex);
        if (header.chunkIndex < assembly.nextChunkIndex) {
            if (previousPacket !== undefined && this.sameBytes(previousPacket, packet)) {
                this.lastAcceptedAt = now;

                return undefined;
            }

            this.clearPending();

            return undefined;
        }

        if (
            header.chunkIndex !== assembly.nextChunkIndex ||
            !this.sameHeader(assembly.header, header) ||
            header.samplesInPacket > header.sampleCount - assembly.samples.length
        ) {
            this.clearPending();

            return undefined;
        }

        return assembly;
    }

    private appendChunkSamples(value: DataView, header: IChunkHeader, assembly: IChunkAssembly): boolean {
        for (let offset = HEADER_LENGTH; offset < value.byteLength; offset += SAMPLE_LENGTH) {
            const sample: IPhysicalForceCurveV2Point = {
                distance: value.getFloat32(offset, true),
                elapsedTimeUs: value.getUint32(offset + 4, true),
                force: value.getFloat32(offset + 8, true),
            };
            const previousSample = assembly.samples.at(-1);
            if (
                !Number.isFinite(sample.distance) ||
                !Number.isFinite(sample.force) ||
                sample.distance < 0 ||
                sample.distance > header.driveLength ||
                sample.elapsedTimeUs > header.driveDurationUs ||
                (previousSample !== undefined &&
                    (sample.distance < previousSample.distance ||
                        sample.elapsedTimeUs < previousSample.elapsedTimeUs))
            ) {
                return false;
            }

            assembly.samples.push(sample);
        }

        return true;
    }

    private completeChunkAssembly(
        header: IChunkHeader,
        assembly: IChunkAssembly,
    ): IPhysicalForceCurveV2 | undefined {
        if (assembly.samples.length !== header.sampleCount) {
            return this.rejectPending();
        }

        const curve: IPhysicalForceCurveV2 = {
            strokeId: header.strokeId,
            driveLength: header.driveLength,
            driveDurationUs: header.driveDurationUs,
            samples: assembly.samples,
        };
        this.lastCompleted = {
            strokeId: header.strokeId,
            packets: assembly.packets,
        };
        this.clearPending();

        return curve;
    }

    private readChunkHeader(value: DataView): IChunkHeader | undefined {
        if (
            value.byteLength < HEADER_LENGTH + SAMPLE_LENGTH ||
            (value.byteLength - HEADER_LENGTH) % SAMPLE_LENGTH !== 0 ||
            value.getUint8(0) !== 2 ||
            value.getUint8(3) !== 0
        ) {
            return undefined;
        }

        const chunkCount = value.getUint8(1);
        const chunkIndex = value.getUint8(2);
        const sampleCount = value.getUint16(6, true);
        const driveLength = value.getFloat32(8, true);
        const samplesInPacket = (value.byteLength - HEADER_LENGTH) / SAMPLE_LENGTH;
        if (
            chunkCount < 1 ||
            chunkIndex < 1 ||
            chunkIndex > chunkCount ||
            sampleCount < 1 ||
            sampleCount > MAX_SAMPLE_COUNT ||
            chunkCount > sampleCount ||
            samplesInPacket > sampleCount ||
            !Number.isFinite(driveLength) ||
            driveLength < 0
        ) {
            return undefined;
        }

        return {
            chunkCount,
            chunkIndex,
            strokeId: value.getUint16(4, true),
            sampleCount,
            driveLength,
            driveDurationUs: value.getUint32(12, true),
            samplesInPacket,
        };
    }

    private sameHeader(first: IChunkHeader, second: IChunkHeader): boolean {
        return (
            first.chunkCount === second.chunkCount &&
            first.strokeId === second.strokeId &&
            first.sampleCount === second.sampleCount &&
            first.driveLength === second.driveLength &&
            first.driveDurationUs === second.driveDurationUs
        );
    }

    private sameBytes(first: Uint8Array, second: Uint8Array): boolean {
        if (first.length !== second.length) {
            return false;
        }

        return first.every((value: number, index: number): boolean => value === second[index]);
    }

    private expireIncompleteTransfer(now: number): void {
        if (
            this.lastAcceptedAt !== undefined &&
            now - this.lastAcceptedAt > INCOMPLETE_TIMEOUT_MS &&
            (this.chunkAssembly !== undefined || this.fragmentAssembly !== undefined)
        ) {
            this.clearPending();
        }
    }

    private clearPending(): void {
        this.chunkAssembly = undefined;
        this.fragmentAssembly = undefined;
        this.lastAcceptedAt = undefined;
    }

    private rejectPending(): undefined {
        this.clearPending();

        return undefined;
    }
}
