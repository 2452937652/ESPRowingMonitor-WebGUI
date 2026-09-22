import { Injectable } from "@angular/core";
import {
    buffer,
    combineLatest,
    distinctUntilChanged,
    filter,
    finalize,
    map,
    Observable,
    of,
    retry,
    share,
    startWith,
    switchMap,
    timer,
} from "rxjs";

import { IBaseMetrics, IExtendedMetrics, IForceCurve } from "../../common.interfaces";
import { observeValue$ } from "../ble.utilities";

import { BaseMetrics } from "./base-metrics";
import { ErgConnectionService } from "./erg-connection.service";

@Injectable({
    providedIn: "root",
})
export class ErgMetricsService {
    constructor(private ergConnectionService: ErgConnectionService) {}

    streamDeltaTimes$(): Observable<Array<number>> {
        return this.ergConnectionService.deltaTimesCharacteristic$.pipe(
            filter(
                (
                    deltaTimesCharacteristic: BluetoothRemoteGATTCharacteristic | undefined,
                ): deltaTimesCharacteristic is BluetoothRemoteGATTCharacteristic =>
                    deltaTimesCharacteristic !== undefined,
            ),
            switchMap(
                (deltaTimesCharacteristic: BluetoothRemoteGATTCharacteristic): Observable<Array<number>> =>
                    this.observeDeltaTimes$(deltaTimesCharacteristic),
            ),
            retry({
                count: 4,
                delay: (error: Error, count: number): Observable<0> => {
                    const gatt =
                        this.ergConnectionService.readDeltaTimesCharacteristic()?.service.device.gatt;
                    if (gatt && error.message.includes("unknown")) {
                        console.warn(`Handle characteristic error: ${error}; retrying: ${count}`);

                        this.ergConnectionService.connectToDeltaTimes(gatt);
                    }

                    return timer(2000);
                },
            }),
        );
    }

    streamExtended$(): Observable<IExtendedMetrics> {
        return this.ergConnectionService.extendedCharacteristic$.pipe(
            filter(
                (
                    extendedCharacteristic: BluetoothRemoteGATTCharacteristic | undefined,
                ): extendedCharacteristic is BluetoothRemoteGATTCharacteristic =>
                    extendedCharacteristic !== undefined,
            ),
            switchMap(
                (extendedCharacteristic: BluetoothRemoteGATTCharacteristic): Observable<IExtendedMetrics> =>
                    this.observeExtended$(extendedCharacteristic),
            ),
            retry({
                count: 4,
                delay: (error: Error, count: number): Observable<0> => {
                    const gatt = this.ergConnectionService.readExtendedCharacteristic()?.service.device.gatt;
                    if (gatt && error.message.includes("unknown")) {
                        console.warn(`Extended metrics characteristic error: ${error}; retrying: ${count}`);

                        this.ergConnectionService.connectToExtended(gatt);
                    }

                    return timer(2000);
                },
            }),
        );
    }

    streamHandleForces$(): Observable<Array<number>> {
        return this.ergConnectionService.handleForceCharacteristic$.pipe(
            filter(
                (
                    handleForceCharacteristic: BluetoothRemoteGATTCharacteristic | undefined,
                ): handleForceCharacteristic is BluetoothRemoteGATTCharacteristic =>
                    handleForceCharacteristic !== undefined,
            ),
            switchMap(
                (handleForceCharacteristic: BluetoothRemoteGATTCharacteristic): Observable<Array<number>> =>
                    this.observeHandleForces$(handleForceCharacteristic),
            ),
            retry({
                count: 4,
                delay: (error: Error, count: number): Observable<0> => {
                    const gatt =
                        this.ergConnectionService.readHandleForceCharacteristic()?.service.device.gatt;
                    if (gatt && error.message.includes("unknown")) {
                        console.warn(`Handle characteristic error: ${error}; retrying: ${count}`);

                        this.ergConnectionService.connectToHandleForces(gatt);
                    }

                    return timer(2000);
                },
            }),
        );
    }

    streamHandleForceCurve$(): Observable<IForceCurve> {
        return this.ergConnectionService.handleForceCurveCharacteristic$.pipe(
            filter(
                (
                    handleForceCurveCharacteristic: BluetoothRemoteGATTCharacteristic | undefined,
                ): handleForceCurveCharacteristic is BluetoothRemoteGATTCharacteristic =>
                    handleForceCurveCharacteristic !== undefined,
            ),
            switchMap(
                (
                    handleForceCurveCharacteristic: BluetoothRemoteGATTCharacteristic,
                ): Observable<IForceCurve> => this.observeHandleForceCurve$(handleForceCurveCharacteristic),
            ),
            retry({
                count: 4,
                delay: (error: Error, count: number): Observable<0> => {
                    const gatt =
                        this.ergConnectionService.readHandleForceCurveCharacteristic()?.service.device.gatt;
                    if (gatt && error.message.includes("unknown")) {
                        console.warn(`Handle force curve characteristic error: ${error}; retrying: ${count}`);

                        this.ergConnectionService.connectToHandleForceCurve(gatt);
                    }

                    return timer(2000);
                },
            }),
        );
    }

    streamMeasurement$(): Observable<IBaseMetrics> {
        return this.ergConnectionService.measurementCharacteristic$.pipe(
            filter(
                (
                    measurementCharacteristic: BluetoothRemoteGATTCharacteristic | undefined,
                ): measurementCharacteristic is BluetoothRemoteGATTCharacteristic =>
                    measurementCharacteristic !== undefined,
            ),
            switchMap(
                (measurementCharacteristic: BluetoothRemoteGATTCharacteristic): Observable<IBaseMetrics> =>
                    this.observeMeasurement$(measurementCharacteristic),
            ),
            distinctUntilChanged(
                (baseMetricsCurrent: IBaseMetrics, baseMetricsPrevious: IBaseMetrics): boolean =>
                    baseMetricsCurrent.distance === baseMetricsPrevious.distance &&
                    baseMetricsCurrent.strokeCount === baseMetricsPrevious.strokeCount,
            ),
            switchMap((baseMetrics: IBaseMetrics): Observable<[IBaseMetrics, number]> =>
                combineLatest([of(baseMetrics), timer(4500).pipe(startWith(0))]),
            ),
            map(([baseMetrics]: [IBaseMetrics, number]): IBaseMetrics => baseMetrics),
            retry({
                count: 4,
                delay: (error: Error, count: number): Observable<0> => {
                    const gatt =
                        this.ergConnectionService.readMeasurementCharacteristic()?.service.device.gatt;
                    if (gatt && error.message.includes("unknown")) {
                        console.warn(`Measurement characteristic error: ${error}; retrying: ${count}`);

                        this.ergConnectionService.connectToMeasurement(gatt);
                    }

                    return timer(2000);
                },
            }),
        );
    }

    private observeDeltaTimes$(
        deltaTimesCharacteristic: BluetoothRemoteGATTCharacteristic,
    ): Observable<Array<number>> {
        return observeValue$(deltaTimesCharacteristic).pipe(
            map((value: DataView): Array<number> => {
                const accumulator = [];
                for (let index = 0; index < value.byteLength; index += 4) {
                    accumulator.push(value.getUint32(index, true));
                }

                return accumulator;
            }),
            finalize((): void => {
                this.ergConnectionService.resetDeltaTimesCharacteristic();
            }),
        );
    }

    private observeExtended$(
        extendedCharacteristic: BluetoothRemoteGATTCharacteristic,
    ): Observable<IExtendedMetrics> {
        return observeValue$(extendedCharacteristic).pipe(
            map((value: DataView): IExtendedMetrics => ({
                avgStrokePower: value.getUint16(0, true),
                driveDuration: Math.round((value.getUint16(2, true) / 4096) * 1e6),
                recoveryDuration: Math.round((value.getUint16(4, true) / 4096) * 1e6),
                dragFactor: value.byteLength >= 8 ? value.getUint16(6, true) : value.getUint8(6),
            })),
            finalize((): void => {
                this.ergConnectionService.resetExtendedCharacteristic();
            }),
        );
    }

    private observeHandleForces$(
        handleForcesCharacteristic: BluetoothRemoteGATTCharacteristic,
    ): Observable<Array<number>> {
        const sharedValues$ = observeValue$(handleForcesCharacteristic).pipe(share());

        return sharedValues$.pipe(
            buffer(
                sharedValues$.pipe(
                    filter((value: DataView): boolean => value.getUint8(0) === value.getUint8(1)),
                ),
            ),
            map((values: Array<DataView>): Array<number> =>
                values.reduce((accumulator: Array<number>, value: DataView): Array<number> => {
                    for (let index = 2; index < value.byteLength; index += 4) {
                        accumulator.push(value.getFloat32(index, true));
                    }

                    return accumulator;
                }, []),
            ),
            finalize((): void => {
                this.ergConnectionService.resetHandleForceCharacteristic();
            }),
        );
    }

    private observeHandleForceCurve$(
        handleForceCurveCharacteristic: BluetoothRemoteGATTCharacteristic,
    ): Observable<IForceCurve> {
        interface ForceCurvePacket {
            version: number;
            totalChunks: number;
            chunkIndex: number;
            strokeId: number;
            totalSamples: number;
            driveLength: number;
            driveDuration: number;
            samples: IForceCurve["samples"];
        }

        const packets$ = observeValue$(handleForceCurveCharacteristic).pipe(
            map((value: DataView): ForceCurvePacket | undefined => {
                const headerSize = 16;
                const sampleSize = 12;
                if (value.byteLength < headerSize || (value.byteLength - headerSize) % sampleSize !== 0) {
                    return undefined;
                }

                const totalChunks = value.getUint8(1);
                const chunkIndex = value.getUint8(2);
                if (
                    value.getUint8(0) !== 1 ||
                    totalChunks === 0 ||
                    chunkIndex === 0 ||
                    chunkIndex > totalChunks
                ) {
                    return undefined;
                }

                const samples: IForceCurve["samples"] = [];
                for (let offset = headerSize; offset < value.byteLength; offset += sampleSize) {
                    samples.push({
                        distance: value.getFloat32(offset, true),
                        elapsedTime: value.getUint32(offset + 4, true) / 1e6,
                        force: value.getFloat32(offset + 8, true),
                    });
                }

                return {
                    version: value.getUint8(0),
                    totalChunks,
                    chunkIndex,
                    strokeId: value.getUint16(4, true),
                    totalSamples: value.getUint16(6, true),
                    driveLength: value.getFloat32(8, true),
                    driveDuration: value.getUint32(12, true) / 1e6,
                    samples,
                };
            }),
            filter(
                (packet: ForceCurvePacket | undefined): packet is ForceCurvePacket => packet !== undefined,
            ),
            share(),
        );

        return packets$.pipe(
            buffer(
                packets$.pipe(
                    filter((packet: ForceCurvePacket): boolean => packet.chunkIndex === packet.totalChunks),
                ),
            ),
            map((packets: Array<ForceCurvePacket>): IForceCurve | undefined => {
                if (packets.length === 0) {
                    return undefined;
                }

                const first = packets[0];
                const sortedPackets = [...packets].sort(
                    (left: ForceCurvePacket, right: ForceCurvePacket): number =>
                        left.chunkIndex - right.chunkIndex,
                );
                if (
                    sortedPackets.length !== first.totalChunks ||
                    sortedPackets.some(
                        (packet: ForceCurvePacket, index: number): boolean =>
                            packet.version !== first.version ||
                            packet.strokeId !== first.strokeId ||
                            packet.totalChunks !== first.totalChunks ||
                            packet.chunkIndex !== index + 1,
                    )
                ) {
                    return undefined;
                }

                const samples = sortedPackets.flatMap(
                    (packet: ForceCurvePacket): IForceCurve["samples"] => packet.samples,
                );
                if (samples.length !== first.totalSamples) {
                    return undefined;
                }

                return {
                    strokeId: first.strokeId,
                    driveLength: first.driveLength,
                    driveDuration: first.driveDuration,
                    samples,
                };
            }),
            filter((curve: IForceCurve | undefined): curve is IForceCurve => curve !== undefined),
            finalize((): void => {
                this.ergConnectionService.resetHandleForceCurveCharacteristic();
            }),
        );
    }

    private observeMeasurement$(
        measurementCharacteristic: BluetoothRemoteGATTCharacteristic,
    ): Observable<IBaseMetrics> {
        const baseMetrics = new BaseMetrics();

        return observeValue$(measurementCharacteristic).pipe(
            map((value: DataView): IBaseMetrics => {
                return baseMetrics.parseMeasurement(measurementCharacteristic.uuid, value);
            }),
            finalize((): void => {
                this.ergConnectionService.resetMeasurementCharacteristic();
            }),
        );
    }
}
