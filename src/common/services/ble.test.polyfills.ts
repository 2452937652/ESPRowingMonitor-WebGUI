import { vi } from "vitest";

export function stubBluetooth(): void {
    if (Object.hasOwn(navigator, "bluetooth") === false) {
        Object.defineProperty(navigator, "bluetooth", { configurable: true, writable: true, value: {} });

        vi.stubGlobal("BluetoothUUID", {
            getCharacteristic: (uuid: BluetoothCharacteristicUUID): string => uuid.toString(),
        });
    }
}

stubBluetooth();
