/** Build one historical row per logical stroke without treating coasting updates as new strokes. */
export function sessionStrokeRecords<
    T extends {
        strokeCount: number;
        strokeKey?: string;
        sourceEpoch?: number;
        strokeRate: number;
        distPerStroke: number;
        driveDuration: number;
    },
>(records: ReadonlyArray<T>): Array<T> {
    const strokes = new Map<string, T>();
    for (const current of records) {
        const key = current.strokeKey ?? `legacy:${current.strokeCount}`;
        const previous = strokes.get(key);
        // v2 rows already have explicit completion semantics. Legacy idle/base
        // notifications can zero cadence/distance while retaining the same ID.
        strokes.set(
            key,
            previous === undefined || current.sourceEpoch !== undefined
                ? current
                : {
                      ...current,
                      strokeRate: current.strokeRate > 0 ? current.strokeRate : previous.strokeRate,
                      distPerStroke:
                          current.distPerStroke > 0 ? current.distPerStroke : previous.distPerStroke,
                      driveDuration:
                          current.driveDuration > 0 ? current.driveDuration : previous.driveDuration,
                  },
        );
    }

    return [...strokes.values()];
}
