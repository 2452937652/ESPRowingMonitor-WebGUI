import { Injectable } from "@angular/core";
import {
    buffer,
    combineLatest,
    defer,
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
import { ForceCurveDecoder } from "./force-curve-decoder";

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
            switchMap(
                (characteristic: BluetoothRemoteGATTCharacteristic | undefined): Observable<IForceCurve> =>
                    characteristic === undefined ? of() : this.observeHandleForceCurve$(characteristic),
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

    /** True only while the connected firmware exposes the stroke-keyed V2 curve characteristic. */
    streamHandleForceCurveSupport$(): Observable<boolean> {
        return this.ergConnectionService.handleForceCurveCharacteristic$.pipe(
            map(
                (characteristic: BluetoothRemoteGATTCharacteristic | undefined): boolean =>
                    characteristic !== undefined,
            ),
            distinctUntilChanged(),
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
            map((value: DataView): IExtendedMetrics => {
                // The first eight bytes remain the legacy format. V2 appends a
                // versioned, stroke-keyed extension with 32-bit microseconds,
                // so older clients continue to read their original fields.
                const isV2 = value.byteLength >= 20 && value.getUint8(8) === 2;

                return {
                    avgStrokePower: value.getUint16(0, true),
                    driveDuration: isV2
                        ? value.getUint32(12, true)
                        : Math.round((value.getUint16(2, true) / 4096) * 1e6),
                    recoveryDuration: isV2
                        ? value.getUint32(16, true)
                        : Math.round((value.getUint16(4, true) / 4096) * 1e6),
                    dragFactor: value.byteLength >= 8 ? value.getUint16(6, true) : value.getUint8(6),
                    ...(isV2
                        ? {
                              strokeId: value.getUint16(10, true),
                              recoveryMetricsComplete: (value.getUint8(9) & 0x01) !== 0,
                              legacyDurationClamped: (value.getUint8(9) & 0x02) !== 0,
                          }
                        : {}),
                };
            }),
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
        return defer((): Observable<IForceCurve> => {
            const decoder = new ForceCurveDecoder();

            return observeValue$(handleForceCurveCharacteristic).pipe(
                map((value: DataView): IForceCurve | undefined => decoder.accept(value)),
                filter((curve: IForceCurve | undefined): curve is IForceCurve => curve !== undefined),
                finalize((): void => decoder.reset()),
            );
        });
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
