import { TestBed } from "@angular/core/testing";
import { MatSnackBar } from "@angular/material/snack-bar";
import { afterEach, beforeEach, describe, expect, it, Mock, vi } from "vitest";

import {
    BATTERY_LEVEL_CHARACTERISTIC,
    BATTERY_LEVEL_SERVICE,
    COMPLETED_STROKE_METRICS_V2_CHARACTERISTIC,
    COMPLETED_STROKE_METRICS_V2_SERVICE,
    CYCLING_POWER_CHARACTERISTIC,
    CYCLING_POWER_SERVICE,
    CYCLING_SPEED_AND_CADENCE_CHARACTERISTIC,
    CYCLING_SPEED_AND_CADENCE_SERVICE,
    DELTA_TIMES_CHARACTERISTIC,
    EXTENDED_CHARACTERISTIC,
    EXTENDED_METRICS_SERVICE,
    FITNESS_MACHINE_SERVICE,
    HANDLE_FORCES_CHARACTERISTIC,
    PHYSICAL_FORCE_CURVE_V2_CHARACTERISTIC,
    PHYSICAL_FORCE_CURVE_V2_SERVICE,
    ROWER_DATA_CHARACTERISTIC,
    SETTINGS_CHARACTERISTIC,
    SETTINGS_SERVICE,
    STROKE_SETTINGS_CHARACTERISTIC,
} from "../../ble.interfaces";
import { Config, IErgConnectionStatus } from "../../common.interfaces";
import { deepMerge } from "../../utils/utility.functions";
import {
    changedListenerReadyFactory,
    createMockBluetooth,
    createMockBluetoothDevice,
    createMockCharacteristic,
    ListenerTrigger,
} from "../ble.test.helpers";
import { ConfigManagerService } from "../config-manager.service";

import { ErgConnectionService } from "./erg-connection.service";

describe("ErgConnectionService", (): void => {
    let ergConnectionService: ErgConnectionService;
    let matSnackBarSpy: Pick<MatSnackBar, "open">;
    let configManagerServiceSpy: Pick<ConfigManagerService, "getGroup" | "setGroup">;
    let mockBluetoothDevice: BluetoothDevice;
    let mockBluetooth: Bluetooth | undefined;
    let createDisconnectChangedListenerReady: () => Promise<ListenerTrigger<void>>;
    let mockBatteryCharacteristic: BluetoothRemoteGATTCharacteristic;
    let mockCyclingPowerCharacteristic: BluetoothRemoteGATTCharacteristic;
    let mockCscCharacteristic: BluetoothRemoteGATTCharacteristic;
    let mockRowerDataCharacteristic: BluetoothRemoteGATTCharacteristic;
    let mockExtendedCharacteristic: BluetoothRemoteGATTCharacteristic;
    let mockHandleForcesCharacteristic: BluetoothRemoteGATTCharacteristic;
    let mockDeltaTimesCharacteristic: BluetoothRemoteGATTCharacteristic;
    let mockPhysicalForceCurveV2Characteristic: BluetoothRemoteGATTCharacteristic;
    let mockCompletedStrokeMetricsV2Characteristic: BluetoothRemoteGATTCharacteristic;
    let mockSettingsCharacteristic: BluetoothRemoteGATTCharacteristic;
    let mockStrokeSettingsCharacteristic: BluetoothRemoteGATTCharacteristic;
    let mockBatteryService: Pick<BluetoothRemoteGATTService, "getCharacteristic">;
    let mockCyclingPowerService: Pick<BluetoothRemoteGATTService, "getCharacteristic">;
    let mockCscService: Pick<BluetoothRemoteGATTService, "getCharacteristic">;
    let mockFitnessService: Pick<BluetoothRemoteGATTService, "getCharacteristic">;
    let mockExtendedService: Pick<BluetoothRemoteGATTService, "getCharacteristic">;
    let mockPhysicalForceCurveV2Service: Pick<BluetoothRemoteGATTService, "getCharacteristic">;
    let mockCompletedStrokeMetricsV2Service: Pick<BluetoothRemoteGATTService, "getCharacteristic">;
    let mockSettingsService: Pick<BluetoothRemoteGATTService, "getCharacteristic">;
    let connectionSpies: {
        connectToMeasurement: Mock;
        connectToExtended: Mock;
        connectToHandleForces: Mock;
        connectToDeltaTimes: Mock;
        connectToSettings: Mock;
        connectToStrokeSettings: Mock;
        connectToBattery: Mock;
        connectToPhysicalForceCurveV2: Mock;
        connectToCompletedStrokeMetricsV2: Mock;
    };

    const setupConnectionSpies = (): typeof connectionSpies => {
        return {
            connectToMeasurement: vi.spyOn(ergConnectionService, "connectToMeasurement").mockResolvedValue(),
            connectToExtended: vi.spyOn(ergConnectionService, "connectToExtended").mockResolvedValue(),
            connectToHandleForces: vi
                .spyOn(ergConnectionService, "connectToHandleForces")
                .mockResolvedValue(),
            connectToDeltaTimes: vi.spyOn(ergConnectionService, "connectToDeltaTimes").mockResolvedValue(),
            connectToSettings: vi.spyOn(ergConnectionService, "connectToSettings").mockResolvedValue(),
            connectToStrokeSettings: vi
                .spyOn(ergConnectionService, "connectToStrokeSettings")
                .mockResolvedValue(),
            connectToBattery: vi.spyOn(ergConnectionService, "connectToBattery").mockResolvedValue(),
            connectToPhysicalForceCurveV2: vi
                .spyOn(ergConnectionService, "connectToPhysicalForceCurveV2")
                .mockResolvedValue(),
            connectToCompletedStrokeMetricsV2: vi
                .spyOn(ergConnectionService, "connectToCompletedStrokeMetricsV2")
                .mockResolvedValue(),
        };
    };

    beforeEach((): void => {
        matSnackBarSpy = {
            open: vi.fn(),
        };
        configManagerServiceSpy = {
            getGroup: vi.fn(),
            setGroup: vi.fn(),
        };

        vi.mocked(configManagerServiceSpy.getGroup).mockReturnValue(
            deepMerge(new Config().general, { device: { ergoMonitorBleId: "mock-device-id" } }),
        );

        vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

        mockBluetoothDevice = createMockBluetoothDevice("mock-device-id", "Mock Ergo", true);
        mockBluetooth = createMockBluetooth(mockBluetoothDevice);

        mockBatteryCharacteristic = createMockCharacteristic(mockBluetoothDevice);
        mockCyclingPowerCharacteristic = createMockCharacteristic(mockBluetoothDevice);
        mockCscCharacteristic = createMockCharacteristic(mockBluetoothDevice);
        mockRowerDataCharacteristic = createMockCharacteristic(mockBluetoothDevice);
        mockExtendedCharacteristic = createMockCharacteristic(mockBluetoothDevice);
        mockHandleForcesCharacteristic = createMockCharacteristic(mockBluetoothDevice);
        mockDeltaTimesCharacteristic = createMockCharacteristic(mockBluetoothDevice);
        mockPhysicalForceCurveV2Characteristic = createMockCharacteristic(mockBluetoothDevice);
        mockCompletedStrokeMetricsV2Characteristic = createMockCharacteristic(mockBluetoothDevice);
        mockSettingsCharacteristic = createMockCharacteristic(mockBluetoothDevice);
        mockStrokeSettingsCharacteristic = createMockCharacteristic(mockBluetoothDevice);

        mockBatteryService = {
            getCharacteristic: vi.fn(),
        };
        mockCyclingPowerService = {
            getCharacteristic: vi.fn(),
        };
        mockCscService = {
            getCharacteristic: vi.fn(),
        };
        mockFitnessService = {
            getCharacteristic: vi.fn(),
        };
        mockExtendedService = {
            getCharacteristic: vi.fn(),
        };
        mockPhysicalForceCurveV2Service = {
            getCharacteristic: vi.fn(),
        };
        mockCompletedStrokeMetricsV2Service = {
            getCharacteristic: vi.fn(),
        };
        mockSettingsService = {
            getCharacteristic: vi.fn(),
        };

        const gattServer = mockBluetoothDevice.gatt!;
        vi.mocked(gattServer.connect).mockResolvedValue(gattServer);
        vi.mocked(gattServer.getPrimaryService).mockImplementation(
            (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                if (service === BATTERY_LEVEL_SERVICE)
                    return Promise.resolve(mockBatteryService as BluetoothRemoteGATTService);
                if (service === CYCLING_POWER_SERVICE)
                    return Promise.resolve(mockCyclingPowerService as BluetoothRemoteGATTService);
                if (service === CYCLING_SPEED_AND_CADENCE_SERVICE)
                    return Promise.resolve(mockCscService as BluetoothRemoteGATTService);
                if (service === FITNESS_MACHINE_SERVICE)
                    return Promise.resolve(mockFitnessService as BluetoothRemoteGATTService);
                if (service === EXTENDED_METRICS_SERVICE)
                    return Promise.resolve(mockExtendedService as BluetoothRemoteGATTService);
                if (service === PHYSICAL_FORCE_CURVE_V2_SERVICE)
                    return Promise.resolve(mockPhysicalForceCurveV2Service as BluetoothRemoteGATTService);
                if (service === COMPLETED_STROKE_METRICS_V2_SERVICE)
                    return Promise.resolve(mockCompletedStrokeMetricsV2Service as BluetoothRemoteGATTService);
                if (service === SETTINGS_SERVICE)
                    return Promise.resolve(mockSettingsService as BluetoothRemoteGATTService);

                return Promise.reject(new Error(`Service ${service} not found`));
            },
        );

        vi.mocked(mockBatteryService.getCharacteristic).mockImplementation(
            (char: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic> => {
                if (char === BATTERY_LEVEL_CHARACTERISTIC) return Promise.resolve(mockBatteryCharacteristic);

                return Promise.reject(new Error(`Characteristic ${char} not found`));
            },
        );

        vi.mocked(mockCyclingPowerService.getCharacteristic).mockImplementation(
            (char: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic> => {
                if (char === CYCLING_POWER_CHARACTERISTIC)
                    return Promise.resolve(mockCyclingPowerCharacteristic);

                return Promise.reject(new Error(`Characteristic ${char} not found`));
            },
        );

        vi.mocked(mockCscService.getCharacteristic).mockImplementation(
            (char: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic> => {
                if (char === CYCLING_SPEED_AND_CADENCE_CHARACTERISTIC)
                    return Promise.resolve(mockCscCharacteristic);

                return Promise.reject(new Error(`Characteristic ${char} not found`));
            },
        );

        vi.mocked(mockFitnessService.getCharacteristic).mockImplementation(
            (char: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic> => {
                if (char === ROWER_DATA_CHARACTERISTIC) return Promise.resolve(mockRowerDataCharacteristic);

                return Promise.reject(new Error(`Characteristic ${char} not found`));
            },
        );

        vi.mocked(mockExtendedService.getCharacteristic).mockImplementation(
            (char: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic> => {
                if (char === EXTENDED_CHARACTERISTIC) return Promise.resolve(mockExtendedCharacteristic);
                if (char === HANDLE_FORCES_CHARACTERISTIC)
                    return Promise.resolve(mockHandleForcesCharacteristic);
                if (char === DELTA_TIMES_CHARACTERISTIC) return Promise.resolve(mockDeltaTimesCharacteristic);

                return Promise.reject(new Error(`Characteristic ${char} not found`));
            },
        );

        vi.mocked(mockPhysicalForceCurveV2Service.getCharacteristic).mockImplementation(
            (char: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic> => {
                if (char === PHYSICAL_FORCE_CURVE_V2_CHARACTERISTIC)
                    return Promise.resolve(mockPhysicalForceCurveV2Characteristic);

                return Promise.reject(new Error(`Characteristic ${char} not found`));
            },
        );

        vi.mocked(mockCompletedStrokeMetricsV2Service.getCharacteristic).mockImplementation(
            (char: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic> => {
                if (char === COMPLETED_STROKE_METRICS_V2_CHARACTERISTIC)
                    return Promise.resolve(mockCompletedStrokeMetricsV2Characteristic);

                return Promise.reject(new Error(`Characteristic ${char} not found`));
            },
        );

        vi.mocked(mockSettingsService.getCharacteristic).mockImplementation(
            (char: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic> => {
                if (char === SETTINGS_CHARACTERISTIC) return Promise.resolve(mockSettingsCharacteristic);
                if (char === STROKE_SETTINGS_CHARACTERISTIC)
                    return Promise.resolve(mockStrokeSettingsCharacteristic);

                return Promise.reject(new Error(`Characteristic ${char} not found`));
            },
        );

        createDisconnectChangedListenerReady = changedListenerReadyFactory(
            mockBluetoothDevice,
            "gattserverdisconnected",
        );

        TestBed.configureTestingModule({
            providers: [
                ErgConnectionService,
                { provide: MatSnackBar, useValue: matSnackBarSpy },
                { provide: ConfigManagerService, useValue: configManagerServiceSpy },
            ],
        });

        ergConnectionService = TestBed.inject(ErgConnectionService);
        connectionSpies = setupConnectionSpies();
    });

    it("should instantiate and expose initial 'disconnected' status", (): void => {
        const localStatusEvents: Array<IErgConnectionStatus> = [];

        ergConnectionService.connectionStatus$().subscribe((status: IErgConnectionStatus): void => {
            localStatusEvents.push(status);
        });

        expect(ergConnectionService).toBeTruthy();
        expect(localStatusEvents).toHaveLength(1);
        expect(localStatusEvents[0]).toEqual({ status: "disconnected" });
    });

    describe("disconnectDevice method", (): void => {
        describe("when disconnecting an active device", (): void => {
            let disconnectTrigger: Promise<ListenerTrigger<void>>;

            beforeEach(async (): Promise<void> => {
                await ergConnectionService.discover();
                disconnectTrigger = createDisconnectChangedListenerReady();
            });

            it("should call gattServer.disconnect", async (): Promise<void> => {
                const gattServer = mockBluetoothDevice.gatt!;

                const disconnectPromise = ergConnectionService.disconnectDevice();
                (await disconnectTrigger).triggerChanged();
                await disconnectPromise;

                expect(gattServer.disconnect).toHaveBeenCalled();
            });

            it("should clear the internal bluetoothDevice", async (): Promise<void> => {
                const disconnectPromise = ergConnectionService.disconnectDevice();
                (await disconnectTrigger).triggerChanged();
                await disconnectPromise;

                expect(ergConnectionService.bluetoothDevice).toBeUndefined();
            });

            it("should emit 'disconnected' status", async (): Promise<void> => {
                const localStatusEvents: Array<IErgConnectionStatus> = [];
                ergConnectionService.connectionStatus$().subscribe((status: IErgConnectionStatus): void => {
                    localStatusEvents.push(status);
                });

                const disconnectPromise = ergConnectionService.disconnectDevice();
                (await disconnectTrigger).triggerChanged();
                await disconnectPromise;

                expect(localStatusEvents[localStatusEvents.length - 1]).toEqual({
                    status: "disconnected",
                });
            });
        });

        it("should handle disconnect when no device is connected", async (): Promise<void> => {
            const localStatusEvents: Array<IErgConnectionStatus> = [];
            ergConnectionService.connectionStatus$().subscribe((status: IErgConnectionStatus): void => {
                localStatusEvents.push(status);
            });

            await ergConnectionService.disconnectDevice();

            expect(localStatusEvents[localStatusEvents.length - 1]).toEqual({
                status: "disconnected",
            });
        });
    });

    describe("discover method", (): void => {
        it("should request device", async (): Promise<void> => {
            const connectToMeasurementSpy = connectionSpies.connectToMeasurement;

            await ergConnectionService.discover();

            expect(connectToMeasurementSpy).toHaveBeenCalled();
        });

        it("should request the V2 services as optional services", async (): Promise<void> => {
            const bluetooth: Bluetooth = navigator.bluetooth;
            const requestDeviceSpy = vi.spyOn(bluetooth, "requestDevice");

            await ergConnectionService.discover();

            expect(requestDeviceSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    optionalServices: expect.arrayContaining([
                        PHYSICAL_FORCE_CURVE_V2_SERVICE,
                        COMPLETED_STROKE_METRICS_V2_SERVICE,
                    ]),
                }),
            );
        });

        it("should start the connect flow on successful devce request ", async (): Promise<void> => {
            const connectToMeasurementSpy = connectionSpies.connectToMeasurement;

            await ergConnectionService.discover();

            expect(ergConnectionService.bluetoothDevice?.id).toBe(mockBluetoothDevice.id);
            expect(connectToMeasurementSpy).toHaveBeenCalled();
        });

        it("should fallback to reconnect when user cancels requestDevice", async (): Promise<void> => {
            vi.mocked(mockBluetooth as unknown as Mock).mockReturnValue({
                requestDevice: (): Promise<BluetoothDevice> => Promise.reject(new Error("cancel")),
            } as Bluetooth);
            const reconnectMethodSpy = vi.spyOn(ergConnectionService, "reconnect").mockResolvedValue();

            await ergConnectionService.discover();

            expect(reconnectMethodSpy).toHaveBeenCalled();
        });
    });

    describe("reconnect method", (): void => {
        it("should do nothing when no previously paired device found", async (): Promise<void> => {
            const localStatusEvents: Array<IErgConnectionStatus> = [];
            ergConnectionService.connectionStatus$().subscribe((status: IErgConnectionStatus): void => {
                localStatusEvents.push(status);
            });
            vi.mocked(mockBluetooth as unknown as Mock).mockReturnValue({
                getDevices: (): Promise<Array<BluetoothDevice>> =>
                    Promise.resolve([] as Array<BluetoothDevice>),
            } as Bluetooth);

            await ergConnectionService.reconnect();

            expect(localStatusEvents[localStatusEvents.length - 1]).toEqual(
                expect.objectContaining({ status: "disconnected" }),
            );
        });

        it("should watch advertisements and when document visible emit 'searching'", async (): Promise<void> => {
            const localStatusEvents: Array<IErgConnectionStatus> = [];
            ergConnectionService.connectionStatus$().subscribe((status: IErgConnectionStatus): void => {
                localStatusEvents.push(status);
            });

            await ergConnectionService.reconnect();

            expect(mockBluetoothDevice.watchAdvertisements).toHaveBeenCalled();
            expect(localStatusEvents[localStatusEvents.length - 1].status).toBe("searching");
        });

        it("should retry reconnect when watchAdvertisements throws", async (): Promise<void> => {
            vi.mocked(mockBluetoothDevice).watchAdvertisements.mockRejectedValue(new Error("watch failed"));
            const reconnectMethodSpy = vi.spyOn(ergConnectionService, "reconnect").mockResolvedValue();

            await ergConnectionService.reconnect();

            expect(reconnectMethodSpy).toHaveBeenCalled();
        });
    });

    describe("connection flow", (): void => {
        let localStatusEvents: Array<IErgConnectionStatus>;
        let connectionOrder: Array<string>;

        beforeEach((): void => {
            localStatusEvents = [];
            connectionOrder = [];
            ergConnectionService.connectionStatus$().subscribe((status: IErgConnectionStatus): void => {
                localStatusEvents.push(status);
            });

            connectionSpies.connectToMeasurement.mockImplementation(async (): Promise<void> => {
                connectionOrder.push("measurement");
            });
            connectionSpies.connectToExtended.mockImplementation(async (): Promise<void> => {
                connectionOrder.push("extended");
            });
            connectionSpies.connectToHandleForces.mockImplementation(async (): Promise<void> => {
                connectionOrder.push("handleForces");
            });
            connectionSpies.connectToDeltaTimes.mockImplementation(async (): Promise<void> => {
                connectionOrder.push("deltaTimes");
            });
            connectionSpies.connectToSettings.mockImplementation(async (): Promise<void> => {
                connectionOrder.push("settings");
            });
            connectionSpies.connectToStrokeSettings.mockImplementation(async (): Promise<void> => {
                connectionOrder.push("strokeSettings");
            });
            connectionSpies.connectToBattery.mockImplementation(async (): Promise<void> => {
                connectionOrder.push("battery");
            });
            connectionSpies.connectToPhysicalForceCurveV2.mockImplementation(async (): Promise<void> => {
                connectionOrder.push("physicalForceCurveV2");
            });
            connectionSpies.connectToCompletedStrokeMetricsV2.mockImplementation(async (): Promise<void> => {
                connectionOrder.push("completedStrokeMetricsV2");
            });
        });

        describe("on successful connection", (): void => {
            it("should call all connectTo* methods", async (): Promise<void> => {
                await ergConnectionService.discover();

                expect(connectionOrder).toHaveLength(9);
                expect(connectionSpies.connectToMeasurement).toHaveBeenCalled();
                expect(connectionSpies.connectToExtended).toHaveBeenCalled();
                expect(connectionSpies.connectToHandleForces).toHaveBeenCalled();
                expect(connectionSpies.connectToDeltaTimes).toHaveBeenCalled();
                expect(connectionSpies.connectToSettings).toHaveBeenCalled();
                expect(connectionSpies.connectToStrokeSettings).toHaveBeenCalled();
                expect(connectionSpies.connectToBattery).toHaveBeenCalled();
                expect(connectionSpies.connectToPhysicalForceCurveV2).toHaveBeenCalled();
                expect(connectionSpies.connectToCompletedStrokeMetricsV2).toHaveBeenCalled();
            });

            it("should call connectTo* methods in correct order", async (): Promise<void> => {
                await ergConnectionService.discover();

                expect(connectionOrder).toEqual([
                    "measurement",
                    "extended",
                    "handleForces",
                    "deltaTimes",
                    "settings",
                    "strokeSettings",
                    "battery",
                    "physicalForceCurveV2",
                    "completedStrokeMetricsV2",
                ]);
            });

            it("should set status to connected with device name", async (): Promise<void> => {
                await ergConnectionService.discover();

                const lastStatus: IErgConnectionStatus = localStatusEvents[localStatusEvents.length - 1];
                expect(lastStatus.status).toBe("connected");
                expect(lastStatus.deviceName).toBe("Mock Ergo");
            });

            it("should save device id in config", async (): Promise<void> => {
                await ergConnectionService.discover();

                expect(configManagerServiceSpy.setGroup).toHaveBeenCalledWith(
                    "general",
                    expect.objectContaining({
                        device: expect.objectContaining({ ergoMonitorBleId: mockBluetoothDevice.id }),
                    }),
                );
            });

            it("should show success snack message", async (): Promise<void> => {
                await ergConnectionService.discover();

                expect(matSnackBarSpy.open).toHaveBeenCalledWith("Ergo monitor connected", "Dismiss");
            });

            it("should set disconnect handler", async (): Promise<void> => {
                const disconnectReady = createDisconnectChangedListenerReady();

                await ergConnectionService.discover();

                await expect(disconnectReady).resolves.not.toThrow();
            });

            it("should stay connected when an older device lacks both optional V2 services", async (): Promise<void> => {
                vi.useFakeTimers();
                const getPrimaryService = vi.mocked(mockBluetoothDevice.gatt!.getPrimaryService);
                const originalGetPrimaryService = getPrimaryService.getMockImplementation();
                const infoSpy = vi.spyOn(console, "info").mockImplementation((): void => undefined);
                connectionSpies.connectToPhysicalForceCurveV2.mockRestore();
                connectionSpies.connectToCompletedStrokeMetricsV2.mockRestore();
                getPrimaryService.mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (
                            service === PHYSICAL_FORCE_CURVE_V2_SERVICE ||
                            service === COMPLETED_STROKE_METRICS_V2_SERVICE
                        ) {
                            return Promise.reject(new Error("Optional service not present"));
                        }

                        return originalGetPrimaryService!(service);
                    },
                );

                try {
                    const discovery = ergConnectionService.discover();
                    await vi.runAllTimersAsync();
                    await discovery;

                    expect(localStatusEvents[localStatusEvents.length - 1].status).toBe("connected");
                    expect(ergConnectionService.readPhysicalForceCurveV2Characteristic()).toBeUndefined();
                    expect(ergConnectionService.readCompletedStrokeMetricsV2Characteristic()).toBeUndefined();
                    expect(connectionSpies.connectToMeasurement).toHaveBeenCalled();
                    expect(infoSpy).toHaveBeenCalledTimes(2);
                } finally {
                    infoSpy.mockRestore();
                    vi.useRealTimers();
                }
            });
        });

        describe("on connection failure", (): void => {
            let isGattConnectedSpy: Mock<() => boolean>;

            beforeEach((): void => {
                isGattConnectedSpy = vi.spyOn(mockBluetoothDevice.gatt!, "connected", "get");
            });

            it("should set disconnected status when connection error occurs", async (): Promise<void> => {
                connectionSpies.connectToMeasurement.mockRejectedValue(new Error("connection failed"));

                await ergConnectionService.discover();

                const lastStatus: IErgConnectionStatus = localStatusEvents[localStatusEvents.length - 1];
                expect(lastStatus.status).toBe("disconnected");
            });

            it("should show error snack message when connection fails", async (): Promise<void> => {
                connectionSpies.connectToMeasurement.mockRejectedValue(new Error("connection failed"));

                await ergConnectionService.discover();

                expect(matSnackBarSpy.open).toHaveBeenCalled();
            });

            it("should trigger reconnect when gatt is not connected after error", async (): Promise<void> => {
                isGattConnectedSpy.mockReturnValue(false);
                connectionSpies.connectToMeasurement.mockRejectedValue(new Error("connection failed"));
                const reconnectMethodSpy = vi.spyOn(ergConnectionService, "reconnect").mockResolvedValue();

                await ergConnectionService.discover();

                expect(reconnectMethodSpy).toHaveBeenCalled();
            });

            it("should handle gatt.connect returning falsy value", async (): Promise<void> => {
                vi.mocked(mockBluetoothDevice.gatt!.connect).mockResolvedValue(
                    undefined as unknown as BluetoothRemoteGATTServer,
                );

                await ergConnectionService.discover();

                const lastStatus: IErgConnectionStatus = localStatusEvents[localStatusEvents.length - 1];
                expect(lastStatus.status).toBe("disconnected");
                expect(matSnackBarSpy.open).toHaveBeenCalledWith("BLE Connection to EPRM failed", "Dismiss");
            });
        });
    });

    describe("event handling", (): void => {
        let disconnectReady: Promise<ListenerTrigger<void>>;

        beforeEach(async (): Promise<void> => {
            disconnectReady = createDisconnectChangedListenerReady();
            await ergConnectionService.discover();
        });

        it("should handle disconnect via gattserverdisconnected event", async (): Promise<void> => {
            const reconnectMethodSpy = vi.spyOn(ergConnectionService, "reconnect").mockResolvedValue();

            (await disconnectReady).triggerChanged();

            expect(reconnectMethodSpy).toHaveBeenCalled();
            expect(matSnackBarSpy.open).toHaveBeenCalledWith("Ergometer Monitor disconnected", "Dismiss");
        });

        it("should reconnect by handling advertisement event", async (): Promise<void> => {
            const advertisementTrigger = changedListenerReadyFactory(
                mockBluetoothDevice,
                "advertisementreceived",
            )();

            (await disconnectReady).triggerChanged();
            await ergConnectionService.reconnect();
            (await advertisementTrigger).triggerChanged();

            expect(mockBluetoothDevice.watchAdvertisements).toHaveBeenCalled();
            expect(connectionSpies.connectToMeasurement).toHaveBeenCalled();
        });
    });

    describe("individual connectTo* methods", (): void => {
        let mockGattServer: BluetoothRemoteGATTServer;
        let connectedSpy: Mock;

        beforeEach(async (): Promise<void> => {
            vi.useFakeTimers();
            mockGattServer = mockBluetoothDevice.gatt!;
            connectedSpy = vi.spyOn(mockGattServer, "connected", "get");

            connectionSpies.connectToBattery.mockReset();
            connectionSpies.connectToExtended.mockReset();
            connectionSpies.connectToHandleForces.mockReset();
            connectionSpies.connectToDeltaTimes.mockReset();
            connectionSpies.connectToSettings.mockReset();
            connectionSpies.connectToStrokeSettings.mockReset();
            connectionSpies.connectToMeasurement.mockReset();
            connectionSpies.connectToPhysicalForceCurveV2.mockReset();
            connectionSpies.connectToCompletedStrokeMetricsV2.mockReset();

            // eslint-disable-next-line no-underscore-dangle
            (
                ergConnectionService as unknown as {
                    _bluetoothDevice: BluetoothDevice;
                }
            )._bluetoothDevice = mockBluetoothDevice;
        });

        afterEach((): void => {
            vi.useRealTimers();
        });

        describe("connectToBattery", (): void => {
            it("should connect successfully when service is available", async (): Promise<void> => {
                const result = ergConnectionService.connectToBattery(mockGattServer);

                await vi.runAllTimersAsync();

                expect(await result).toBeDefined();
                expect(ergConnectionService.readBatteryCharacteristic()).toBeDefined();
            });

            it("should show snackbar when service is unavailable but device is connected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(true);
                vi.mocked(mockGattServer.getPrimaryService).mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (service === BATTERY_LEVEL_SERVICE) {
                            return Promise.reject(new Error("Service unavailable device connected - test"));
                        }

                        return Promise.reject(new Error(`Service ${service} not found`));
                    },
                );

                ergConnectionService.connectToBattery(mockGattServer).catch((): void => {
                    // no-op
                });
                await vi.runAllTimersAsync();

                expect(matSnackBarSpy.open).toHaveBeenCalledWith(
                    "Ergo battery service is unavailable",
                    "Dismiss",
                );
            });

            it("should propagate error when device is disconnected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(false);

                vi.mocked(mockGattServer.getPrimaryService).mockImplementationOnce(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (service === BATTERY_LEVEL_SERVICE) {
                            return Promise.reject(new Error("Service unavailable - test"));
                        }

                        return Promise.reject(new Error(`Service ${service} not found`));
                    },
                );

                await expect(ergConnectionService.connectToBattery(mockGattServer)).rejects.toThrow();
            });
        });

        describe("connectToExtended", (): void => {
            it("should connect successfully when service is available", async (): Promise<void> => {
                const result = ergConnectionService.connectToExtended(mockGattServer);

                await vi.runAllTimersAsync();

                expect(await result).toBeDefined();
                expect(ergConnectionService.readExtendedCharacteristic()).toBeDefined();
            });

            it("should show snackbar when service is unavailable but device is connected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(true);
                vi.mocked(mockGattServer.getPrimaryService).mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (service === EXTENDED_METRICS_SERVICE) {
                            return Promise.reject(new Error("Service unavailable - test"));
                        }

                        return Promise.reject(new Error(`Service ${service} not found`));
                    },
                );

                ergConnectionService.connectToExtended(mockGattServer).catch((): void => {
                    // no-op
                });
                await vi.runAllTimersAsync();

                expect(matSnackBarSpy.open).toHaveBeenCalledWith(
                    "Error connecting to Extended Metrics",
                    "Dismiss",
                );
            });

            it("should propagate error when device is disconnected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(false);
                const gattServer = mockBluetoothDevice.gatt!;
                vi.mocked(gattServer.getPrimaryService).mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (service === EXTENDED_METRICS_SERVICE) {
                            return Promise.reject(new Error("Service unavailable - test"));
                        }

                        return Promise.reject(new Error(`Service ${service} not found`));
                    },
                );

                await expect(ergConnectionService.connectToExtended(gattServer)).rejects.toThrow();
            });
        });

        describe("connectToHandleForces", (): void => {
            it("should connect successfully when service is available", async (): Promise<void> => {
                const result = ergConnectionService.connectToHandleForces(mockGattServer);

                await vi.runAllTimersAsync();

                expect(await result).toBeDefined();
                expect(ergConnectionService.readHandleForceCharacteristic()).toBeDefined();
            });

            it("should show snackbar when service is unavailable but device is connected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(true);
                vi.mocked(mockGattServer.getPrimaryService).mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (service === EXTENDED_METRICS_SERVICE) {
                            return Promise.reject(new Error("Service unavailable - test"));
                        }

                        return Promise.resolve(mockExtendedService as BluetoothRemoteGATTService);
                    },
                );

                ergConnectionService.connectToHandleForces(mockGattServer).catch((): void => {
                    // no-op
                });
                await vi.runAllTimersAsync();

                expect(matSnackBarSpy.open).toHaveBeenCalledWith(
                    "Error connecting to Handles Forces",
                    "Dismiss",
                );
            });
        });

        describe("connectToDeltaTimes", (): void => {
            it("should connect successfully when service is available", async (): Promise<void> => {
                const result = ergConnectionService.connectToDeltaTimes(mockGattServer);

                await vi.runAllTimersAsync();

                expect(await result).toBeDefined();
                expect(ergConnectionService.readDeltaTimesCharacteristic()).toBeDefined();
            });

            it("should show snackbar when service is unavailable but device is connected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(true);
                vi.mocked(mockGattServer.getPrimaryService).mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (service === EXTENDED_METRICS_SERVICE) {
                            return Promise.reject(new Error("Service unavailable - test"));
                        }

                        return Promise.resolve(mockExtendedService as BluetoothRemoteGATTService);
                    },
                );

                ergConnectionService.connectToDeltaTimes(mockGattServer).catch((): void => {
                    // no-op
                });
                await vi.runAllTimersAsync();

                expect(matSnackBarSpy.open).toHaveBeenCalledWith(
                    "Error connecting to Delta Times",
                    "Dismiss",
                );
            });
        });

        describe("connectToPhysicalForceCurveV2", (): void => {
            it("should connect successfully when the optional service is available", async (): Promise<void> => {
                const result = ergConnectionService.connectToPhysicalForceCurveV2(mockGattServer);

                await vi.runAllTimersAsync();

                expect(await result).toBe(mockPhysicalForceCurveV2Characteristic);
                expect(ergConnectionService.readPhysicalForceCurveV2Characteristic()).toBe(
                    mockPhysicalForceCurveV2Characteristic,
                );
            });

            it("should continue without a snackbar when the optional service is absent", async (): Promise<void> => {
                connectedSpy.mockReturnValue(true);
                vi.mocked(mockGattServer.getPrimaryService).mockRejectedValue(
                    new Error("Service not present"),
                );
                const infoSpy = vi.spyOn(console, "info").mockImplementation((): void => undefined);
                const result = ergConnectionService.connectToPhysicalForceCurveV2(mockGattServer);

                await vi.runAllTimersAsync();

                expect(await result).toBeUndefined();
                expect(ergConnectionService.readPhysicalForceCurveV2Characteristic()).toBeUndefined();
                expect(matSnackBarSpy.open).not.toHaveBeenCalled();
                expect(infoSpy).toHaveBeenCalledOnce();
                infoSpy.mockRestore();
            });
        });

        describe("connectToCompletedStrokeMetricsV2", (): void => {
            it("should connect successfully when the optional service is available", async (): Promise<void> => {
                const result = ergConnectionService.connectToCompletedStrokeMetricsV2(mockGattServer);

                await vi.runAllTimersAsync();

                expect(await result).toBe(mockCompletedStrokeMetricsV2Characteristic);
                expect(ergConnectionService.readCompletedStrokeMetricsV2Characteristic()).toBe(
                    mockCompletedStrokeMetricsV2Characteristic,
                );
            });

            it("should continue without a snackbar when the optional service is absent", async (): Promise<void> => {
                connectedSpy.mockReturnValue(true);
                vi.mocked(mockGattServer.getPrimaryService).mockRejectedValue(
                    new Error("Service not present"),
                );
                const infoSpy = vi.spyOn(console, "info").mockImplementation((): void => undefined);
                const result = ergConnectionService.connectToCompletedStrokeMetricsV2(mockGattServer);

                await vi.runAllTimersAsync();

                expect(await result).toBeUndefined();
                expect(ergConnectionService.readCompletedStrokeMetricsV2Characteristic()).toBeUndefined();
                expect(matSnackBarSpy.open).not.toHaveBeenCalled();
                expect(infoSpy).toHaveBeenCalledOnce();
                infoSpy.mockRestore();
            });
        });

        describe("connectToMeasurement", (): void => {
            it("should connect successfully when service is available", async (): Promise<void> => {
                const result = ergConnectionService.connectToMeasurement(mockGattServer);

                await vi.runAllTimersAsync();

                expect(await result).toBeDefined();
                expect(ergConnectionService.readMeasurementCharacteristic()).toBeDefined();
            });

            it("should show snackbar when service is unavailable but device is connected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(true);
                vi.mocked(mockGattServer.getPrimaryService).mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (
                            service === CYCLING_POWER_SERVICE ||
                            service === CYCLING_SPEED_AND_CADENCE_SERVICE ||
                            service === FITNESS_MACHINE_SERVICE
                        ) {
                            return Promise.reject(new Error("Service unavailable - test"));
                        }

                        return Promise.resolve(mockCyclingPowerService as BluetoothRemoteGATTService);
                    },
                );

                ergConnectionService.connectToMeasurement(mockGattServer).catch((): void => {
                    // no-op
                });
                await vi.runAllTimersAsync();

                expect(matSnackBarSpy.open).toHaveBeenCalledWith(
                    "Error connecting to Measurement Characteristic",
                    "Dismiss",
                );
            });

            it("should propagate error when device is disconnected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(false);
                vi.mocked(mockGattServer.getPrimaryService).mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (
                            service === CYCLING_POWER_SERVICE ||
                            service === CYCLING_SPEED_AND_CADENCE_SERVICE ||
                            service === FITNESS_MACHINE_SERVICE
                        ) {
                            return Promise.reject(new Error("Service unavailable - test"));
                        }

                        return Promise.resolve(mockCyclingPowerService as BluetoothRemoteGATTService);
                    },
                );

                await expect(ergConnectionService.connectToMeasurement(mockGattServer)).rejects.toThrow();
            });
        });

        describe("connectToSettings", (): void => {
            it("should connect successfully when service is available", async (): Promise<void> => {
                const result = ergConnectionService.connectToSettings(mockGattServer);

                await vi.runAllTimersAsync();

                expect(await result).toBeDefined();
                expect(ergConnectionService.readSettingsCharacteristic()).toBeDefined();
            });

            it("should show snackbar when service is unavailable but device is connected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(true);
                vi.mocked(mockGattServer.getPrimaryService).mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (service === SETTINGS_SERVICE) {
                            return Promise.reject(new Error("Service unavailable - test"));
                        }

                        return Promise.resolve(mockSettingsService as BluetoothRemoteGATTService);
                    },
                );

                ergConnectionService.connectToSettings(mockGattServer).catch((): void => {
                    // no-op
                });
                await vi.runAllTimersAsync();

                expect(matSnackBarSpy.open).toHaveBeenCalledWith("Error connecting to Settings", "Dismiss");
            });

            it("should propagate error when device is disconnected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(false);
                vi.mocked(mockGattServer.getPrimaryService).mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (service === SETTINGS_SERVICE) {
                            return Promise.reject(new Error("Service unavailable - test"));
                        }

                        return Promise.resolve(mockSettingsService as BluetoothRemoteGATTService);
                    },
                );

                await expect(ergConnectionService.connectToSettings(mockGattServer)).rejects.toThrow();
            });
        });

        describe("connectToStrokeSettings", (): void => {
            it("should connect successfully when service is available", async (): Promise<void> => {
                const result = ergConnectionService.connectToStrokeSettings(mockGattServer);

                await vi.runAllTimersAsync();

                expect(await result).toBeDefined();
                expect(ergConnectionService.readStrokeSettingsCharacteristic()).toBeDefined();
            });

            it("should show snackbar when service is unavailable but device is connected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(true);
                vi.mocked(mockGattServer.getPrimaryService).mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (service === SETTINGS_SERVICE) {
                            return Promise.reject(new Error("Service unavailable - test"));
                        }

                        return Promise.resolve(mockSettingsService as BluetoothRemoteGATTService);
                    },
                );

                ergConnectionService.connectToStrokeSettings(mockGattServer).catch((): void => {
                    // no-op
                });
                await vi.runAllTimersAsync();

                expect(matSnackBarSpy.open).toHaveBeenCalledWith(
                    "Error connecting to Stroke Detection Settings",
                    "Dismiss",
                );
            });

            it("should propagate error when device is disconnected", async (): Promise<void> => {
                connectedSpy.mockReturnValue(false);
                vi.mocked(mockGattServer.getPrimaryService).mockImplementation(
                    (service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> => {
                        if (service === SETTINGS_SERVICE) {
                            return Promise.reject(new Error("Service unavailable - test"));
                        }

                        return Promise.resolve(mockSettingsService as BluetoothRemoteGATTService);
                    },
                );

                await expect(ergConnectionService.connectToStrokeSettings(mockGattServer)).rejects.toThrow();
            });
        });
    });
});
