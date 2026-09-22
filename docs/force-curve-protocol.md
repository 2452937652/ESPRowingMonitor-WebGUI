# Physical force curves: compatibility and validation

The distance-aware characteristic accepts two wire formats. Existing firmware
continues to work. All integers and IEEE float32 values are little endian.

Version 1 notification: 16-byte header followed by 12-byte samples.
Header offsets: version=1 at 0, chunk count at 1, one-based chunk index at 2,
reserved=0 at 3, uint16 strokeId at 4, uint16 total samples at 6, float32 total
drive metres at 8, uint32 drive microseconds at 12. Each sample carries float32
metres, uint32 elapsed microseconds, float32 newtons. It requires ATT MTU >=31.

For ATT MTU 23–30, updated firmware sends a version 2 byte envelope around one
complete version 1 packet (chunk count/index both 1): version=2 at 0, reserved=0
at 1, uint16 strokeId at 2, uint16 complete byte length at 4, uint16 byte offset
at 6, then at most MTU-11 bytes. No notification exceeds MTU-3 bytes. A curve
contains at most 255 samples. The receiver abandons an incomplete stroke when a
new first packet arrives, checks ordering and header consistency, and clears
state on disconnect. A packet gap over five seconds invalidates pending data;
memory remains bounded even if the final packet never arrives.

Long drives use bounded physical samples retaining the start, end and greatest
force. Intermediate points may be simplified; full-resolution retention is not
promised after capacity is reached. Firmware stroke detection is independent of
that capacity. The old force-only characteristic retains a uniformly spaced
prefix for compatibility; its clients cannot reconstruct full long drives.

The dashboard holds a 0–2m horizontal scale until a drive exceeds it, then grows
to whole metres and retains that scale for comparison. History uses a shared
physical scale. Records without distance use an explicitly labelled sample
index; mixed continuous history also uses sample indices throughout. Peak
markers use the actual highest-force sample position.

Run `npm run test:force-curve` for deterministic regression checks using actual
TypeScript functions and jsdom. Angular decorators/signals are substituted in
these focused tests, so they do not replace browser rendering or live BLE tests.
Run the normal Angular test suite and build as well when the browser runtime is
available. MTU 23–30 and long-drive acquisition require the updated firmware;
updating only this WebGUI cannot repair an old firmware sender.
