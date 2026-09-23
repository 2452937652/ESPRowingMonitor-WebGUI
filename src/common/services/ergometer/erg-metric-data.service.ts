import { Injectable } from "@angular/core";
import {
    buffer,
    combineLatest,
    distinctUntilChanged,
    EMPTY,
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

import {
    COMPLETED_STROKE_METRICS_V2_CHARACTERISTIC,
    COMPLETED_STROKE_METRICS_V2_SERVICE,
    DELTA_TIMES_CHARACTERISTIC,
    PHYSICAL_FORCE_CURVE_V2_CHARACTERISTIC,
    PHYSICAL_FORCE_CURVE_V2_SERVICE,
} from "../../ble.interfaces";
import { IBaseMetrics, IExtendedMetrics } from "../../common.interfaces";
import { observeValue$ } from "../ble.utilities";

import { BaseMetrics } from "./base-metrics";
import { decodeCompletedStrokeMetricsV2, ICompletedStrokeMetricsV2 } from "./completed-stroke-v2-decoder";
import { ErgConnectionService } from "./erg-connection.service";
import { IPhysicalForceCurveV2, PhysicalForceCurveV2Decoder } from "./physical-force-curve-v2-decoder";

function isKnownForceCurveChunk(value: DataView): boolean {
    if (value.byteLength < 28 || value.byteLength > 16 + 255 * 12 || (value.byteLength - 16) % 12 !== 0) {
        return false;
    }

    if ((value.getUint8(0) !== 1 && value.getUint8(0) !== 2) || value.getUint8(3) !== 0) {
        return false;
    }

    const chunkCount = value.getUint8(1);
    const chunkIndex = value.getUint8(2);
    const sampleCount = value.getUint16(6, true);
    const chunkSampleCount = (value.byteLength - 16) / 12;
    const driveLength = value.getFloat32(8, true);

    return (
        chunkCount > 0 &&
        chunkIndex > 0 &&
        chunkIndex <= chunkCount &&
        sampleCount > 0 &&
        sampleCount <= 255 &&
        chunkSampleCount <= sampleCount &&
        chunkCount <= sampleCount &&
        Number.isFinite(driveLength) &&
        driveLength >= 0
    );
}

function isKnownForceCurveFragment(value: DataView): boolean {
    if (value.byteLength <= 8) {
        return false;
    }
    const isLegacyFragment = value.getUint8(0) === 2 && value.getUint8(1) === 0;
    const isV2Fragment = value.getUint8(0) === 0xf2 && value.getUint8(1) === 2;
    if (!isLegacyFragment && !isV2Fragment) {
        return false;
    }

    const curveLength = value.getUint16(4, true);
    const offset = value.getUint16(6, true);

    return (
        curveLength >= 28 &&
        curveLength <= 16 + 255 * 12 &&
        (curveLength - 16) % 12 === 0 &&
        offset < curveLength &&
        value.byteLength - 8 <= curveLength - offset
    );
}

function isKnownForceCurveFrame(value: DataView): boolean {
    return isKnownForceCurveChunk(value) || isKnownForceCurveFragment(value);
}

function hasExpectedBleRoute(
    characteristic: BluetoothRemoteGATTCharacteristic,
    serviceUUID: string,
    characteristicUUID: string,
): boolean {
    return (
        characteristic.service?.uuid?.toLowerCase() === serviceUUID.toLowerCase() &&
        characteristic.uuid.toLowerCase() === characteristicUUID.toLowerCase()
    );
}

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
                (deltaTimesCharacteristic: BluetoothRemoteGATTCharacteristic): Observable<Array<number>> => {
                    if (
                        deltaTimesCharacteristic.uuid.toLowerCase() !==
                        DELTA_TIMES_CHARACTERISTIC.toLowerCase()
                    ) {
                        console.warn(
                            `Ignoring unexpected Delta Times characteristic UUID: ${deltaTimesCharacteristic.uuid}`,
                        );

                        return of();
                    }

                    return this.observeDeltaTimes$(deltaTimesCharacteristic);
                },
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

    streamPhysicalForceCurveV2$(): Observable<IPhysicalForceCurveV2> {
        return this.ergConnectionService.physicalForceCurveV2Characteristic$.pipe(
            filter(
                (
                    characteristic: BluetoothRemoteGATTCharacteristic | undefined,
                ): characteristic is BluetoothRemoteGATTCharacteristic => characteristic !== undefined,
            ),
            switchMap(
                (characteristic: BluetoothRemoteGATTCharacteristic): Observable<IPhysicalForceCurveV2> => {
                    if (
                        !hasExpectedBleRoute(
                            characteristic,
                            PHYSICAL_FORCE_CURVE_V2_SERVICE,
                            PHYSICAL_FORCE_CURVE_V2_CHARACTERISTIC,
                        )
                    ) {
                        console.warn(
                            "Ignoring Physical Force Curve V2 notification from an unexpected GATT route",
                        );

                        return EMPTY;
                    }

                    return this.observePhysicalForceCurveV2$(characteristic);
                },
            ),
            share(),
        );
    }

    streamCompletedStrokeMetricsV2$(): Observable<ICompletedStrokeMetricsV2> {
        return this.ergConnectionService.completedStrokeMetricsV2Characteristic$.pipe(
            filter(
                (
                    characteristic: BluetoothRemoteGATTCharacteristic | undefined,
                ): characteristic is BluetoothRemoteGATTCharacteristic => characteristic !== undefined,
            ),
            switchMap(
                (
                    characteristic: BluetoothRemoteGATTCharacteristic,
                ): Observable<ICompletedStrokeMetricsV2> => {
                    if (
                        !hasExpectedBleRoute(
                            characteristic,
                            COMPLETED_STROKE_METRICS_V2_SERVICE,
                            COMPLETED_STROKE_METRICS_V2_CHARACTERISTIC,
                        )
                    ) {
                        console.warn(
                            "Ignoring Completed Stroke Metrics V2 notification from an unexpected GATT route",
                        );

                        return EMPTY;
                    }

                    return this.observeCompletedStrokeMetricsV2$(characteristic);
                },
            ),
            share(),
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
            map((value: DataView): Array<number> | undefined => {
                if (isKnownForceCurveFrame(value)) {
                    console.warn(
                        "Ignoring Physical Force Curve frame received on Delta Times characteristic",
                    );

                    return undefined;
                }

                if (value.byteLength === 0 || value.byteLength % 4 !== 0) {
                    console.warn(
                        "Ignoring malformed Delta Times notification with an empty or non-word-aligned length",
                    );

                    return undefined;
                }

                const accumulator = [];
                for (let index = 0; index < value.byteLength; index += 4) {
                    accumulator.push(value.getUint32(index, true));
                }

                return accumulator;
            }),
            filter(
                (deltaTimes: Array<number> | undefined): deltaTimes is Array<number> =>
                    deltaTimes !== undefined,
            ),
            finalize((): void => {
                this.ergConnectionService.resetDeltaTimesCharacteristic();
            }),
        );
    }

    private observePhysicalForceCurveV2$(
        characteristic: BluetoothRemoteGATTCharacteristic,
    ): Observable<IPhysicalForceCurveV2> {
        const decoder = new PhysicalForceCurveV2Decoder();

        return observeValue$(characteristic).pipe(
            map((value: DataView): IPhysicalForceCurveV2 | undefined => decoder.accept(value)),
            filter(
                (curve: IPhysicalForceCurveV2 | undefined): curve is IPhysicalForceCurveV2 =>
                    curve !== undefined,
            ),
            finalize((): void => {
                decoder.reset();
                this.ergConnectionService.resetPhysicalForceCurveV2Characteristic();
            }),
        );
    }

    private observeCompletedStrokeMetricsV2$(
        characteristic: BluetoothRemoteGATTCharacteristic,
    ): Observable<ICompletedStrokeMetricsV2> {
        return observeValue$(characteristic).pipe(
            map((value: DataView): ICompletedStrokeMetricsV2 | undefined => {
                const metrics = decodeCompletedStrokeMetricsV2(value);
                if (metrics === undefined) {
                    console.warn("Ignoring invalid Completed Stroke Metrics V2 notification");
                }

                return metrics;
            }),
            filter(
                (metrics: ICompletedStrokeMetricsV2 | undefined): metrics is ICompletedStrokeMetricsV2 =>
                    metrics !== undefined,
            ),
            finalize((): void => {
                this.ergConnectionService.resetCompletedStrokeMetricsV2Characteristic();
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
