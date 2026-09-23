import { vi } from "vitest";

export function stubBluetooth(): void {
    if ("bluetooth" in navigator === false) {
        Object.defineProperty(navigator, "bluetooth", {
            configurable: true,
            value: {} as Bluetooth,
            writable: true,
        });
    }

    if (typeof BluetoothUUID === "undefined") {
        vi.stubGlobal("BluetoothUUID", {
            getCharacteristic: (uuid: BluetoothCharacteristicUUID): string => uuid.toString(),
        });
    }
}

stubBluetooth();
