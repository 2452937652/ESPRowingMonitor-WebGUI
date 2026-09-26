import { describe, expect, it } from "vitest";

import { StrokeBaseTracker } from "./stroke-base-tracker";

describe("stroke boundaries", (): void => {
    it("preserves cadence through coasting, handles uint16 wrap, and clears the baseline after reset", (): void => {
        const tracker = new StrokeBaseTracker();
        tracker.accept({ strokeCount: 65535, strokeTime: 3e6, revTime: 3e6, distance: 1000 });
        expect(tracker.accept({ strokeCount: 0, strokeTime: 6e6, revTime: 6e6, distance: 1900 })).toEqual({
            strokeRate: 20,
            distPerStroke: 9,
        });
        expect(tracker.accept({ strokeCount: 0, strokeTime: 6e6, revTime: 7e6, distance: 2200 })).toEqual({
            strokeRate: 20,
            distPerStroke: 9,
        });
        expect(tracker.accept({ strokeCount: 0, strokeTime: 0, revTime: 0, distance: 0 })).toEqual({
            strokeRate: 0,
            distPerStroke: 0,
        });
        expect(tracker.accept({ strokeCount: 1, strokeTime: 3e6, revTime: 3e6, distance: 800 })).toEqual({
            strokeRate: 20,
            distPerStroke: 8,
        });
    });
});
