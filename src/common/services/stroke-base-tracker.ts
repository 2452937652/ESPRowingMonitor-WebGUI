import { IBaseMetrics } from "../common.interfaces";

export interface StrokeBaseObservation {
    base: IBaseMetrics;
    stroke: { strokeRate: number; distPerStroke: number };
}

/** Cadence/distance use stroke boundaries; wheel-only notifications only update speed. */
export class StrokeBaseTracker {
    private boundary: IBaseMetrics | undefined;
    private latest: IBaseMetrics | undefined;
    private cadence: number = 0;
    private strokeDistance: number = 0;

    accept(current: IBaseMetrics): { strokeRate: number; distPerStroke: number } {
        const previous = this.latest;
        const boundary = this.boundary;
        const delta =
            boundary === undefined ? 0 : (current.strokeCount - boundary.strokeCount + 65536) % 65536;
        if (previous === undefined || current.distance < previous.distance || delta > 32768) {
            this.boundary = current;
            this.cadence = 0;
            this.strokeDistance = 0;
        } else if (boundary !== undefined && delta > 0) {
            const duration = current.strokeTime - boundary.strokeTime;
            this.cadence = duration > 0 ? (delta * 60e6) / duration : 0;
            this.strokeDistance = Math.max(0, current.distance - boundary.distance) / 100 / delta;
            this.boundary = current;
        }
        const isStopped =
            previous !== undefined &&
            current.distance === previous.distance &&
            current.strokeCount === previous.strokeCount &&
            current.revTime === previous.revTime;
        this.latest = current;

        return { strokeRate: isStopped ? 0 : this.cadence, distPerStroke: this.strokeDistance };
    }
}
