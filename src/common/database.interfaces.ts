import { ForceCurveStatus, IForceCurve, IForceCurvePoint, ISessionData } from "./common.interfaces";

export interface ISessionUploadEntity {
    sessionId: number;
    uploadedAt?: number;
}

export interface IMetricsEntity extends Omit<
    ISessionData,
    | "peakForce"
    | "peakForcePositionNorm"
    | "handleForces"
    | "driveLength"
    | "totalWork"
    | "powerBalance"
    | "powerBalancePairCount"
> {
    sessionId: number;
    timeStamp: number;
    /** Stable per-stroke identity for v5 rows. Omitted on preserved v4 data. */
    strokeKey?: string;
    sourceEpoch?: number;
    sourceStrokeId?: number;
    forceCurve?: IForceCurve;
    forceCurveStatus?: ForceCurveStatus;
    isExtendedMetricsPending?: boolean;
}

export interface IHandleForcesEntity {
    timeStamp: number;
    sessionId: number;
    strokeId: number;
    handleForces: Array<number>;
    driveLength: number;
    forceCurve?: Array<IForceCurvePoint>;
    forceCurveStatus?: ForceCurveStatus;
}

export interface IDeltaTimesEntity {
    sessionId: number;
    timeStamp: number;
    deltaTimes: Array<number>;
}

export interface IConnectedDeviceEntity {
    sessionId: number;
    deviceName: string;
}

export interface ISessionMetadataEntity {
    sessionId: number;
    /** Wall-clock time when the session was explicitly stopped, in milliseconds. */
    finishAt: number;
    /** Elapsed active session time at stop, in seconds. */
    elapsedTime: number;
}

/** Metadata used to persist one logical stroke and to merge later supplements. */
export interface IStrokePersistenceIdentity {
    sourceEpoch?: number;
    sourceStrokeId?: number;
    /** Monotonic/logical stroke count used for legacy devices without V2 identity. */
    logicalStrokeCount?: number;
    forceCurve?: IForceCurve;
    forceCurveStatus?: ForceCurveStatus;
    isExtendedMetricsPending?: boolean;
}

export type LapType = "manual" | "distance" | "time";

export interface ILapEntity {
    sessionId: number;
    timeStamp: number;
    strokeIndex: number;
    type: LapType;
    isPause: boolean;
}

export type IExportRecord = Omit<
    ISessionData,
    | "peakForce"
    | "peakForcePositionNorm"
    | "handleForces"
    | "driveLength"
    | "powerBalance"
    | "powerBalancePairCount"
> & {
    timeStamp: Date;
    strokeKey?: string;
    sourceEpoch?: number;
    sourceStrokeId?: number;
    forceCurve?: IForceCurve;
    forceCurveStatus?: ForceCurveStatus;
    isExtendedMetricsPending?: boolean;
};

export interface IExportHandleForces {
    peakForce: number;
    peakForcePositionNorm: number;
    driveLength: number;
    handleForces: Array<number>;
    forceCurve?: Array<IForceCurvePoint>;
    forceCurveStatus?: ForceCurveStatus;
}

export type ILapExport = Omit<ILapEntity, "sessionId">;

export interface IExportSession {
    /** Identifies the exporting browser build, not the firmware or original recording build. */
    exportedBy?: { metricsRevision: string; buildTime: string };
    sessionId: number;
    deviceName?: string;
    records: Array<IExportRecord>;
    handleForces: Record<number, IExportHandleForces>;
    laps: Array<ILapExport>;
    /** Explicit stop time for v5 sessions; absent on legacy/v4 imports. */
    finishAt?: number;
    /** Elapsed active time at stop for v5 sessions; absent on legacy/v4 imports. */
    elapsedTime?: number;
}
