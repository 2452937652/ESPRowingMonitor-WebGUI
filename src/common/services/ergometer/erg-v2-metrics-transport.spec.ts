import { BehaviorSubject } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import {
    COMPLETED_STROKE_METRICS_V2_CHARACTERISTIC,
    COMPLETED_STROKE_METRICS_V2_SERVICE,
    PHYSICAL_FORCE_CURVE_V2_CHARACTERISTIC,
    PHYSICAL_FORCE_CURVE_V2_SERVICE,
} from "../../ble.interfaces";

import { ICompletedStrokeMetricsV2 } from "./completed-stroke-v2-decoder";
import { ErgConnectionService } from "./erg-connection.service";
import { ErgMetricsService } from "./erg-metric-data.service";
import { IPhysicalForceCurveV2 } from "./physical-force-curve-v2-decoder";

interface ICharacteristicHarness {
    characteristic: BluetoothRemoteGATTCharacteristic;
    device: EventTarget;
    notify: (value: DataView) => void;
}

interface IMetricTransportHarness {
    service: ErgMetricsService;
    physicalCharacteristic: BehaviorSubject<BluetoothRemoteGATTCharacteristic | undefined>;
    completedCharacteristic: BehaviorSubject<BluetoothRemoteGATTCharacteristic | undefined>;
    resetPhysical: ReturnType<typeof vi.fn>;
    resetCompleted: ReturnType<typeof vi.fn>;
}

function createCharacteristicHarness(
    serviceUUID: string,
    characteristicUUID: string,
): ICharacteristicHarness {
    const device = new EventTarget();
    const characteristic = new EventTarget() as unknown as BluetoothRemoteGATTCharacteristic;
    let currentValue: DataView | undefined;
    const startNotifications = vi.fn().mockResolvedValue(characteristic);
    Object.defineProperties(characteristic, {
        uuid: { configurable: true, value: characteristicUUID },
        service: {
            configurable: true,
            value: { uuid: serviceUUID, device: device as BluetoothDevice },
        },
        value: {
            configurable: true,
            get: (): DataView | undefined => currentValue,
        },
        startNotifications: { configurable: true, value: startNotifications },
    });

    return {
        characteristic,
        device,
        notify: (value: DataView): void => {
            currentValue = value;
            (characteristic as unknown as EventTarget).dispatchEvent(new Event("characteristicvaluechanged"));
        },
    };
}

function createMetricTransportHarness(): IMetricTransportHarness {
    const physicalCharacteristic = new BehaviorSubject<BluetoothRemoteGATTCharacteristic | undefined>(
        undefined,
    );
    const completedCharacteristic = new BehaviorSubject<BluetoothRemoteGATTCharacteristic | undefined>(
        undefined,
    );
    const resetPhysical = vi.fn((): void => physicalCharacteristic.next(undefined));
    const resetCompleted = vi.fn((): void => completedCharacteristic.next(undefined));
    const connection = {
        physicalForceCurveV2Characteristic$: physicalCharacteristic.asObservable(),
        completedStrokeMetricsV2Characteristic$: completedCharacteristic.asObservable(),
        resetPhysicalForceCurveV2Characteristic: resetPhysical,
        resetCompletedStrokeMetricsV2Characteristic: resetCompleted,
    } as unknown as ErgConnectionService;

    return {
        service: new ErgMetricsService(connection),
        physicalCharacteristic,
        completedCharacteristic,
        resetPhysical,
        resetCompleted,
    };
}

interface ICurveSample {
    distance: number;
    elapsedTimeUs: number;
    force: number;
}

function createCurveChunk(
    strokeId: number,
    chunkCount: number,
    chunkIndex: number,
    samples: Array<ICurveSample>,
    totalSamples: number,
): DataView {
    const value = new DataView(new ArrayBuffer(16 + samples.length * 12));
    value.setUint8(0, 2);
    value.setUint8(1, chunkCount);
    value.setUint8(2, chunkIndex);
    value.setUint8(3, 0);
    value.setUint16(4, strokeId, true);
    value.setUint16(6, totalSamples, true);
    value.setFloat32(8, 0.5, true);
    value.setUint32(12, 1_000_000, true);
    samples.forEach((sample: ICurveSample, index: number): void => {
        const offset = 16 + index * 12;
        value.setFloat32(offset, sample.distance, true);
        value.setUint32(offset + 4, sample.elapsedTimeUs, true);
        value.setFloat32(offset + 8, sample.force, true);
    });

    return value;
}

function createCompletedMetrics(flags: number = 1): DataView {
    const value = new DataView(new ArrayBuffer(20));
    value.setUint8(0, 2);
    value.setUint8(1, flags);
    value.setUint16(2, 0x1234, true);
    value.setUint32(4, 800_000, true);
    value.setUint32(8, flags === 0 ? 0 : 1_200_000, true);
    value.setFloat32(12, flags === 0 ? 0 : 230.5, true);
    value.setFloat32(16, flags === 0 ? 0 : 112, true);

    return value;
}

describe("ErgMetricsService V2 BLE transport", (): void => {
    it("emits only a complete physical curve from the expected service and characteristic", (): void => {
        const harness = createMetricTransportHarness();
        const characteristic = createCharacteristicHarness(
            PHYSICAL_FORCE_CURVE_V2_SERVICE.toUpperCase(),
            PHYSICAL_FORCE_CURVE_V2_CHARACTERISTIC.toUpperCase(),
        );
        const emitted: Array<IPhysicalForceCurveV2> = [];
        harness.service.streamPhysicalForceCurveV2$().subscribe((value: IPhysicalForceCurveV2): void => {
            emitted.push(value);
        });
        harness.physicalCharacteristic.next(characteristic.characteristic);

        expect(characteristic.characteristic.startNotifications).toHaveBeenCalledOnce();
        characteristic.notify(
            createCurveChunk(0x1234, 1, 1, [{ distance: 0.25, elapsedTimeUs: 400_000, force: 45.5 }], 1),
        );

        expect(emitted).toEqual([
            {
                strokeId: 0x1234,
                driveLength: 0.5,
                driveDurationUs: 1_000_000,
                samples: [{ distance: 0.25, elapsedTimeUs: 400_000, force: 45.5 }],
            },
        ]);
    });

    it("does not subscribe to a characteristic on the wrong V2 GATT route", (): void => {
        const harness = createMetricTransportHarness();
        const wrongService = createCharacteristicHarness(
            "a72a5762-803b-421d-a759-f0314153da97",
            PHYSICAL_FORCE_CURVE_V2_CHARACTERISTIC,
        );
        const wrongCharacteristic = createCharacteristicHarness(
            PHYSICAL_FORCE_CURVE_V2_SERVICE,
            "3d9c2760-cf91-41ee-87e9-fd99d5f129a4",
        );
        const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
        const emitted: Array<IPhysicalForceCurveV2> = [];
        harness.service.streamPhysicalForceCurveV2$().subscribe((value: IPhysicalForceCurveV2): void => {
            emitted.push(value);
        });

        harness.physicalCharacteristic.next(wrongService.characteristic);
        harness.physicalCharacteristic.next(wrongCharacteristic.characteristic);

        expect(wrongService.characteristic.startNotifications).not.toHaveBeenCalled();
        expect(wrongCharacteristic.characteristic.startNotifications).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(emitted).toEqual([]);
        warnSpy.mockRestore();
    });

    it("resets partial physical curves when the GATT connection disconnects", (): void => {
        const harness = createMetricTransportHarness();
        const firstConnection = createCharacteristicHarness(
            PHYSICAL_FORCE_CURVE_V2_SERVICE,
            PHYSICAL_FORCE_CURVE_V2_CHARACTERISTIC,
        );
        const reconnected = createCharacteristicHarness(
            PHYSICAL_FORCE_CURVE_V2_SERVICE,
            PHYSICAL_FORCE_CURVE_V2_CHARACTERISTIC,
        );
        const emitted: Array<IPhysicalForceCurveV2> = [];
        harness.service.streamPhysicalForceCurveV2$().subscribe((value: IPhysicalForceCurveV2): void => {
            emitted.push(value);
        });
        harness.physicalCharacteristic.next(firstConnection.characteristic);
        firstConnection.notify(
            createCurveChunk(700, 2, 1, [{ distance: 0.1, elapsedTimeUs: 100_000, force: 20 }], 2),
        );

        firstConnection.device.dispatchEvent(new Event("gattserverdisconnected"));
        expect(harness.resetPhysical).toHaveBeenCalledOnce();

        harness.physicalCharacteristic.next(reconnected.characteristic);
        reconnected.notify(
            createCurveChunk(700, 2, 2, [{ distance: 0.2, elapsedTimeUs: 200_000, force: 30 }], 2),
        );
        expect(emitted).toEqual([]);

        reconnected.notify(
            createCurveChunk(700, 2, 1, [{ distance: 0.1, elapsedTimeUs: 100_000, force: 20 }], 2),
        );
        reconnected.notify(
            createCurveChunk(700, 2, 2, [{ distance: 0.2, elapsedTimeUs: 200_000, force: 30 }], 2),
        );

        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toEqual(
            expect.objectContaining({ strokeId: 700, samples: expect.arrayContaining([expect.any(Object)]) }),
        );
    });

    it("emits pending and complete stroke metrics only from the expected route", (): void => {
        const harness = createMetricTransportHarness();
        const characteristic = createCharacteristicHarness(
            COMPLETED_STROKE_METRICS_V2_SERVICE,
            COMPLETED_STROKE_METRICS_V2_CHARACTERISTIC,
        );
        const emitted: Array<ICompletedStrokeMetricsV2> = [];
        harness.service
            .streamCompletedStrokeMetricsV2$()
            .subscribe((value: ICompletedStrokeMetricsV2): void => {
                emitted.push(value);
            });
        harness.completedCharacteristic.next(characteristic.characteristic);

        characteristic.notify(createCompletedMetrics(0));
        characteristic.notify(createCompletedMetrics(1));

        expect(emitted).toEqual([
            {
                strokeId: 0x1234,
                driveDurationUs: 800_000,
                recovery: { status: "pending" },
            },
            {
                strokeId: 0x1234,
                driveDurationUs: 800_000,
                recovery: {
                    status: "complete",
                    durationUs: 1_200_000,
                    avgStrokePowerW: 230.5,
                    dragFactor: 112,
                },
            },
        ]);
    });

    it("logs malformed completed metrics and never emits them", (): void => {
        const harness = createMetricTransportHarness();
        const characteristic = createCharacteristicHarness(
            COMPLETED_STROKE_METRICS_V2_SERVICE,
            COMPLETED_STROKE_METRICS_V2_CHARACTERISTIC,
        );
        const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
        const emitted: Array<ICompletedStrokeMetricsV2> = [];
        harness.service
            .streamCompletedStrokeMetricsV2$()
            .subscribe((value: ICompletedStrokeMetricsV2): void => {
                emitted.push(value);
            });
        harness.completedCharacteristic.next(characteristic.characteristic);

        const malformed = new DataView(new ArrayBuffer(19));
        characteristic.notify(malformed);

        expect(warnSpy).toHaveBeenCalledWith("Ignoring invalid Completed Stroke Metrics V2 notification");
        expect(emitted).toEqual([]);
        warnSpy.mockRestore();
    });
});
