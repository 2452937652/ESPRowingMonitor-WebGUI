// Run with node --test tools/regression/force-curve.regression.cjs.
// Uses real TypeScript functions, jsdom MutationObserver and RxJS-independent
// packet decoding; Angular decorators/signals are lightweight test substitutes.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "../..");
const signal = (value) => {
    const get = () => value;
    get.set = (next) => {
        value = next;
    };
    return get;
};
const language = { t: (value) => value };
const angular = {
    Injectable: () => (value) => value,
    Component: () => (value) => value,
    ChangeDetectionStrategy: { OnPush: 0 },
    signal,
    computed: (fn) => fn,
    input: Object.assign((value) => signal(value), { required: () => signal(undefined) }),
    inject: () => language,
    viewChild: () => () => undefined,
    effect: () => {},
};
function load(relative, globals = {}, suffix = "") {
    const source = fs.readFileSync(path.join(root, relative), "utf8") + suffix;
    const code = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            experimentalDecorators: true,
        },
    }).outputText;
    const context = {
        exports: {},
        require: (name) =>
            name === "@angular/core"
                ? angular
                : name === "ng2-charts"
                  ? { provideCharts: () => ({}) }
                  : name.includes("utility.functions")
                    ? { isKayakErgometer: () => false }
                    : {},
        ...globals,
    };
    vm.runInNewContext(code, context, { timeout: 5000 });
    return context.exports;
}
const { ForceCurveDecoder } = load("src/common/services/ergometer/force-curve-decoder.ts");
function packet(
    stroke,
    index = 1,
    chunks = 1,
    points = [
        [0, 10],
        [0.2, 100],
        [0.9, 20],
    ],
    total = points.length,
) {
    const v = new DataView(new ArrayBuffer(16 + points.length * 12));
    v.setUint8(0, 1);
    v.setUint8(1, chunks);
    v.setUint8(2, index);
    v.setUint16(4, stroke, true);
    v.setUint16(6, total, true);
    v.setFloat32(8, 1, true);
    v.setUint32(12, 1000000, true);
    points.forEach(([distance, force], i) => {
        v.setFloat32(16 + i * 12, distance, true);
        v.setUint32(20 + i * 12, Math.round(distance * 1e6), true);
        v.setFloat32(24 + i * 12, force, true);
    });
    return v;
}
test("language observer settles in English and Chinese and restores dynamic text", async () => {
    const dom = new JSDOM(
        '<body><button title="Settings">Settings</button><pre><span>Settings</span></pre></body>',
        { url: "https://example.test" },
    );
    const w = dom.window;
    let callbacks = 0;
    class BoundedObserver extends w.MutationObserver {
        constructor(callback) {
            super((...args) => {
                if (++callbacks >= 30) this.disconnect();
                else callback(...args);
            });
        }
    }
    const { LanguageService } = load("src/common/services/language.service.ts", {
        document: w.document,
        NodeFilter: w.NodeFilter,
        localStorage: w.localStorage,
        MutationObserver: BoundedObserver,
        queueMicrotask,
    });
    const service = new LanguageService();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    try {
        service.start(w.document.body);
        await settle();
        assert.ok(callbacks < 3, "idle English should not loop");
        service.setLanguage("zh-CN");
        service.scheduleTranslation();
        await settle();
        assert.equal(w.document.querySelector("button").textContent, "设置");
        assert.equal(w.document.querySelector("button").title, "设置");
        assert.equal(w.document.querySelector("pre").textContent, "Settings");
        const count = callbacks;
        await settle();
        assert.equal(callbacks, count);
        w.document.querySelector("button").firstChild.data = "Save";
        await settle();
        assert.equal(w.document.querySelector("button").textContent, "保存");
        service.setLanguage("en");
        service.scheduleTranslation();
        await settle();
        assert.equal(w.document.querySelector("button").textContent, "Save");
        assert.equal(w.document.querySelector("button").title, "Settings");
        service.ngOnDestroy();
        w.document.querySelector("button").firstChild.data = "Settings";
        const stopped = callbacks;
        await settle();
        assert.equal(callbacks, stopped);
        assert.ok(callbacks < 30);
    } finally {
        service.ngOnDestroy();
        w.close();
    }
});
test("lost last packet does not poison the next complete stroke", () => {
    const decoder = new ForceCurveDecoder();
    decoder.accept(packet(10, 1, 2, [[0, 10]], 2));
    decoder.accept(packet(11, 1, 2, [[0, 10]], 2));
    assert.equal(decoder.accept(packet(11, 2, 2, [[0.5, 20]], 2)).strokeId, 11);
});
test("missing, duplicate and out-of-order chunks never publish a partial curve", () => {
    for (const sequence of [
        [1, 3],
        [1, 2, 2, 3],
        [2, 1, 3],
    ]) {
        const decoder = new ForceCurveDecoder();
        for (const i of sequence) assert.equal(decoder.accept(packet(4, i, 3, [[i / 4, 10]], 3)), undefined);
        assert.equal(decoder.accept(packet(5)).strokeId, 5);
    }
});
test("inconsistent headers, NaN, backwards samples and excess size are rejected", () => {
    const decoder = new ForceCurveDecoder();
    const invalid = packet(1);
    invalid.setFloat32(24, NaN, true);
    assert.equal(decoder.accept(invalid), undefined);
    assert.equal(
        decoder.accept(
            packet(1, 1, 1, [
                [0.5, 10],
                [0.1, 20],
            ]),
        ),
        undefined,
    );
    assert.equal(decoder.accept(packet(1, 1, 1, [[0, 10]], 256)), undefined);
    decoder.accept(packet(1, 1, 2, [[0, 10]], 2));
    const next = packet(1, 2, 2, [[0.5, 10]], 2);
    next.setFloat32(8, 2, true);
    assert.equal(decoder.accept(next), undefined);
});
function fragments(v, mtu = 23) {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
        result = [];
    for (let offset = 0; offset < bytes.length; offset += mtu - 11) {
        const data = bytes.slice(offset, offset + mtu - 11);
        const out = new DataView(new ArrayBuffer(8 + data.length));
        out.setUint8(0, 2);
        out.setUint16(2, v.getUint16(4, true), true);
        out.setUint16(4, bytes.length, true);
        out.setUint16(6, offset, true);
        new Uint8Array(out.buffer, 8).set(data);
        result.push(out);
    }
    return result;
}
test("MTU 23 through 30 fragments reconstruct the same isPhysical samples", () => {
    for (let mtu = 23; mtu < 31; mtu++) {
        const decoder = new ForceCurveDecoder();
        let curve;
        for (const frame of fragments(packet(65535), mtu)) {
            assert.ok(frame.byteLength <= mtu - 3);
            curve = decoder.accept(frame);
        }
        assert.equal(curve.strokeId, 65535);
        assert.equal(curve.samples.length, 3);
        assert.ok(Math.abs(curve.samples[1].distance - 0.2) < 1e-6);
        assert.equal(decoder.accept(packet(0)).strokeId, 0);
    }
});
test("fragment loss, timeout and reset recover on the next stroke", () => {
    const decoder = new ForceCurveDecoder(),
        frames = fragments(packet(1));
    decoder.accept(frames[0], 10);
    assert.equal(decoder.accept(frames[1], 6000), undefined);
    decoder.accept(frames[0]);
    assert.equal(decoder.accept(frames[2]), undefined);
    for (const frame of fragments(packet(2))) decoder.accept(frame);
    decoder.reset();
    assert.equal(decoder.accept(packet(3)).strokeId, 3);
});
const history = load(
    "src/app/session-detail/components/strokes/session-strokes.component.ts",
    {},
    "\nexport { buildSingleStrokeForceCurve, buildContinuousForceCurveData };",
);
const stroke = {
    driveLength: 1,
    handleForces: [10, 100, 20],
    peakForce: 100,
    peakForcePositionNorm: 20,
    forceCurve: [
        { distance: 0, force: 10 },
        { distance: 0.2, force: 100 },
        { distance: 0.9, force: 20 },
    ],
};
test("isPhysical peak marker follows the measured position, not array percentage", () => {
    assert.equal(history.buildSingleStrokeForceCurve(stroke, 105, "Peak").datasets[1].data[0].x, 0.2);
});
test("legacy and mixed history use a consistent sample-index domain", () => {
    const legacy = { ...stroke, forceCurve: undefined, driveLength: 0, handleForces: [10, 20, 30, 40, 50] };
    const chart = history.buildContinuousForceCurveData([stroke, legacy]);
    assert.equal(chart.isPhysical, false);
    assert.equal(chart.strokeOffsets[1], 2);
    assert.equal(chart.chartData.datasets[0].data.at(-1).x, 6);
    const component = new history.SessionStrokesComponent({});
    component.strokes.set([legacy]);
    assert.equal(component.singleStrokeChartOptions().scales.x.max, 4);
    assert.equal(component.singleStrokeChartOptions().scales.x.title.text, "Sample Index");
});
test("dashboard preserves short distances and expands once for long strokes", () => {
    const { ForceCurveTileComponent } = load("src/app/dashboard/tiles/force-curve-tile.component.ts");
    const tile = new ForceCurveTileComponent();
    tile.label.set("Force Curve");
    tile.displayConfig.set({ forceCurve: { showAxisLabels: true, showGridLines: true } });
    for (const length of [0.2, 0.9, 1.5]) {
        tile.rowingData.set({
            ...stroke,
            driveLength: length,
            forceCurve: [{ distance: length, force: 20 }],
        });
        assert.equal(tile.forceChartOptions().scales.x.max, 2);
        assert.equal(tile.curvePoints().at(-1).x, length);
    }
    tile.rowingData.set({ ...stroke, driveLength: 2.8 });
    assert.equal(tile.forceChartOptions().scales.x.max, 3);
    tile.rowingData.set(stroke);
    assert.equal(tile.forceChartOptions().scales.x.max, 3);
    tile.rowingData.set({ ...stroke, driveLength: 0, forceCurve: undefined, handleForces: [1, 2, 3, 4, 5] });
    assert.equal(tile.forceChartOptions().scales.x.max, 4);
    assert.equal(tile.forceChartOptions().scales.x.ticks.callback(3), "3");
});
