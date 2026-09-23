export type ICompletedStrokeV2Recovery =
    | {
          status: "pending";
      }
    | {
          status: "complete";
          durationUs: number;
          avgStrokePowerW: number;
          dragFactor: number;
      };

/** decoded fields from one Completed Stroke Metrics V2 notification. */
export interface ICompletedStrokeMetricsV2 {
    strokeId: number;
    /** Drive duration, in microseconds. */
    driveDurationUs: number;
    recovery: ICompletedStrokeV2Recovery;
}

const PAYLOAD_LENGTH = 20;
const PROTOCOL_VERSION = 2;
const MAX_DRIVE_DURATION_US = 60_000_000;
const MAX_RECOVERY_DURATION_US = 3_600_000_000;
const MAX_AVG_STROKE_POWER_W = 10_000;
const MAX_DRAG_FACTOR = 1_000;

/** decode a Completed Stroke Metrics V2 notification, returning undefined on invalid data. */
export function decodeCompletedStrokeMetricsV2(value: DataView): ICompletedStrokeMetricsV2 | undefined {
    if (value.byteLength !== PAYLOAD_LENGTH || value.getUint8(0) !== PROTOCOL_VERSION) {
        return undefined;
    }

    const flags = value.getUint8(1);
    if ((flags & 0xfe) !== 0) {
        return undefined;
    }

    const strokeId = value.getUint16(2, true);
    const driveDurationUs = value.getUint32(4, true);
    if (driveDurationUs === 0 || driveDurationUs > MAX_DRIVE_DURATION_US) {
        return undefined;
    }

    if ((flags & 0x01) === 0) {
        // recovery bytes have no measurement meaning until the completion flag is set.
        return {
            strokeId,
            driveDurationUs,
            recovery: { status: "pending" },
        };
    }

    const recoveryDurationUs = value.getUint32(8, true);
    const avgStrokePowerW = value.getFloat32(12, true);
    const dragFactor = value.getFloat32(16, true);
    if (
        recoveryDurationUs === 0 ||
        recoveryDurationUs > MAX_RECOVERY_DURATION_US ||
        !Number.isFinite(avgStrokePowerW) ||
        !Number.isFinite(dragFactor) ||
        avgStrokePowerW < 0 ||
        avgStrokePowerW > MAX_AVG_STROKE_POWER_W ||
        dragFactor < 0 ||
        dragFactor > MAX_DRAG_FACTOR
    ) {
        return undefined;
    }

    return {
        strokeId,
        driveDurationUs,
        recovery: {
            status: "complete",
            durationUs: recoveryDurationUs,
            avgStrokePowerW,
            dragFactor,
        },
    };
}
