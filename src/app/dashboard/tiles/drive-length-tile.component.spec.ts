import { ComponentFixture, TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import { createMockMetrics } from "./dashboard-tile.test.helpers";
import { DriveLengthTileComponent } from "./drive-length-tile.component";

describe("DriveLengthTileComponent", (): void => {
    it("displays metres stored internally as rounded centimetres", async (): Promise<void> => {
        await TestBed.configureTestingModule({ imports: [DriveLengthTileComponent] }).compileComponents();
        const fixture: ComponentFixture<DriveLengthTileComponent> = TestBed.createComponent(DriveLengthTileComponent);
        fixture.componentRef.setInput("label", "Drive Length");
        fixture.componentRef.setInput("rowingData", createMockMetrics({ driveLength: 1.396 }));
        fixture.detectChanges();
        await fixture.whenStable();

        expect(fixture.nativeElement.textContent).toContain("140");
        expect(fixture.nativeElement.textContent).toContain("cm");
    });
});
