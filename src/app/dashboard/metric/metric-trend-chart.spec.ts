import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import { MetricTrendChartComponent } from "./metric-trend-chart.component";

describe("fixed stroke trend slots", (): void => {
    it("fills from the left without moving existing slots and retains only 20 strokes", (): void => {
        const fixture = TestBed.createComponent(MetricTrendChartComponent);
        fixture.componentRef.setInput("samples", [21]);
        const firstX = fixture.componentInstance.points()[0].x;
        expect(firstX).toBeLessThan(6);
        fixture.componentRef.setInput("samples", [21, 24]);
        expect(fixture.componentInstance.points()[0].x).toBe(firstX);
        expect(fixture.componentInstance.points()[1].x - firstX).toBeCloseTo(5.8);
        fixture.componentRef.setInput(
            "samples",
            Array.from({ length: 25 }, (_: unknown, i: number): number => i),
        );
        expect(fixture.componentInstance.points()).toHaveLength(20);
        expect(fixture.componentInstance.points()[0].x).toBe(firstX);
        expect(fixture.componentInstance.points().at(-1)!.x).toBeLessThan(118);
    });
});
