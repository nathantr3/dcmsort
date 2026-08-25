# dcmsort

Interactive DICOM sorting, splitting, and attribute modification. Point it at a folder, see what
shape the data actually is, define rules that carve it into new series, and export.

dcmsort is the general-purpose successor to
[dcmsplit](https://github.com/nateroberts/dcmsplit). dcmsplit assumes one shape of data — N images
per slice location, with N written into a YAML profile by hand. It cannot describe a series holding
a 58-slice by 9-phase stack *plus* a 58-slice by 3-phase stack *plus* a single-phase reconstruction,
and it offers no way to discover that structure in the first place. dcmsort discovers the structure
and lets you carve it up interactively.

## What it does

1. **Scan.** Recursively reads every DICOM header under a folder and groups them into Exam → Series.
2. **Analyze.** Splits each selected series into **volumes**, each an (x, y, z, p) matrix reported as
   *S slices x P phases*. A series can yield several volumes.
3. **Rule.** Define child series with selections that read as
   `FROM Volume 1 SELECT slices * AND phases 1-3`, and set the attributes each output carries.
4. **Export.** Write to a new folder, or in place.

Rule sets save and load as portable JSON.

## Install and run

```bash
make install
make run                       # launches with the test fixtures loaded
make run OPEN=/path/to/dicoms  # launches with your own folder
make run-blank                 # launches with the folder picker
```

`make` on its own lists every target. The npm scripts work too:
`npm start -- --open /path/to/dicoms`.

## Building

```bash
make dist-mac            # macOS arm64 dmg  -> dist/dcmsort-<version>-arm64.dmg
make dist-mac-x64        # macOS Intel dmg
make dist-mac-universal  # both macOS architectures
make dist-linux          # Linux x86_64 AppImage
make dist-linux-arm64    # Linux arm64 AppImage
make dist-win            # Windows nsis installer
make pack                # unpacked app, no installer
```

Builds are unsigned by default so a local build needs no Developer ID. With a
certificate installed, pass `SIGN=1`:

```bash
make dist-mac SIGN=1
```

The app icon is generated from `build/icon.svg` by `make icon`, which renders it
with the Chromium already inside `node_modules/electron` and packs the result
into `build/icon.icns` with the system `iconutil`. There is no separate image
toolchain to install, and the icon stays reproducible from source. The dist
targets depend on it, so it rebuilds automatically when the SVG changes.

## How volume detection works

This is the part dcmsplit lacks, and where the interesting decisions live
(`src/main/analyze.js`).

**Cohorts.** Files are first split by an acquisition signature — `ImageType`, `EchoNumbers`,
`SequenceName`, `ProtocolName`, `ScanningSequence`, image dimensions, orientation, pixel spacing.
This is what separates a magnitude stack from the phase-contrast and derived maps filed at the same
slice positions in the same series. Grouping on `SliceLocation` alone, as dcmsplit does, merges them.

**Slice key.** Rather than trusting `SliceLocation` — often absent, and inconsistently signed on
oblique acquisitions — dcmsort computes the slice normal as the cross product of the two
`ImageOrientationPatient` vectors and projects `ImagePositionPatient` onto it. It falls back to
`SliceLocation`, then `InstanceNumber`, and tells you in the UI which it used.

**Volumes.** Within a cohort, files are bucketed by slice position. If every position holds the same
number of images, that is one clean volume of *S slices x P phases*. If the counts differ, the cohort
does not fit a single matrix, so each distinct repeat count becomes its own volume and a warning
says so.

**Phase order.** Because phase index is not reliably recorded, dcmsort tries candidate attributes in
order of trust — `TemporalPositionIdentifier`, `TriggerTime`, `AcquisitionNumber`, `EchoNumbers`,
`EchoTime`, `ContentTime`, `AcquisitionTime`, and finally `InstanceNumber` — and picks the first that
yields a consistent index across every slice. The chosen attribute is shown on the volume card in a
dropdown, so a wrong guess is visible and one click from being fixed.

Volume numbering is deliberately deterministic: cohorts are ordered by acquisition, and scan results
are sorted before analysis. Saved rules refer to volumes by position (`v1`), so this has to hold
across sessions.

## Selection syntax

The slices and phases fields accept:

| Input | Meaning |
| --- | --- |
| `*` or empty | every index on that axis |
| `4` | just index 4 |
| `-1` | the last index (`-2` the second to last) |
| `1-3` | an inclusive range |
| `3-` | from 3 to the end |
| `1-9:2` | every second index |
| `1-3,7-` | any combination, comma separated |

## Attributes

**Series number** follows dcmsplit's formula, `scale x baseSeriesNumber + offset` — so scale 100 and
offset 1 turn series 4 into series 401 — or can be set absolutely.

**Series description** either keeps the original (optionally with a label, prefix, and suffix) or
replaces it. It is built in this order:

1. **Strip prefix** comes off the front of the original. This is independent of what gets added, so
   "drop `NOT DIAGNOSTIC:` and add `My Feature:`" is one rule. Matching is case-insensitive and takes
   a trailing colon with it, using dcmsplit's prefix regex.
2. **Also strip the prefix being added** additionally removes the prefix from step 4, so exporting a
   folder twice does not stack `My Feature: My Feature:`.
3. **Label** is placed ahead of what is left as `Label: original`, or in replace mode stands in for
   it entirely.
4. **Prefix** and **suffix** wrap the result.

Output is truncated to the 64-character `LO` limit.

**Identity.** Each child series gets a freshly generated `SeriesInstanceUID` (a real `2.25.` UID, not
dcmsplit's increment of the last component, which can collide with neighbouring series).
`InstanceNumber` is renumbered from 1, either phase-major (each 3D volume contiguous) or slice-major
(each slice's time course contiguous).

If one source file is claimed by more than one child series — legal, and useful — every copy after
the first gets a new `SOPInstanceUID`, because duplicate SOP UIDs under different series break PACS
ingestion.

## Export

**New folder** writes `<out>/<StudyDescription>/<NNN>_<SeriesDescription>/IM-NNNNN.dcm` and leaves
the sources untouched.

**In place** overwrites the source files and requires an explicit acknowledgement. Where a file is
claimed by several child series, the first claim overwrites it and the rest are written alongside it
with the child series id appended. Files no rule claims are left exactly as they were.

Every file is staged to a temporary path and renamed into place, so an interrupted or failing write
never leaves a half-written DICOM. A file that fails is recorded and the export continues.

## Rule files

A saved rule set records **only what it needs to match new data and apply to
it**: no series UID, number or description, nothing about where it came from.

```json
{
  "version": 1,
  "requirements": {
    "volumeCount": 3,
    "volumes": { "v1": { "phases": { "exact": 4 } } }
  },
  "phaseKeyOverrides": { "v1": "TriggerTime" },
  "childSeries": [ ... ]
}
```

`requirements` is the shape the rules need, narrowed to the axes they actually
index. A selection of `slices *` says nothing about how many slices there
should be, so nothing is recorded for that axis and the rules apply to a
30-slice volume and a 300-slice one alike. An axis indexed by position is
pinned to the extent it was written against - `phases 1-2` off a 4-phase volume
requires 4 phases, not 2 - so a rule always fits the data it was built on. The
relative and open-ended forms exist to follow the size of the data, so `-1` and
`3-` set a floor rather than a fixed extent.

Volume count is matched exactly: a rule built where the series analyzed into
three volumes applies only where three come out again.

## Command line

The same engine runs headless, for scripting a saved rule set over a folder:

```bash
dcmsort apply --rules cardiac.dcmsort.json --folder /data/patient42 --out /data/out
dcmsort apply --rules cardiac.dcmsort.json --folder /data/patient42 --in-place
dcmsort list    --folder /data/patient42      # exams, series, UIDs
dcmsort analyze --folder /data/patient42      # detected volumes, slices x phases
```

`apply` takes **each series in the folder on its own**: it analyzes that series
alone - so its volumes always start at `v1` - and offers the rule set to it. A
series whose shape does not match is skipped with a reason and the run carries
on, which is what lets one saved file be re-run over folders it was not built
on.

Narrow the run with `--series`, repeatable, taking a SeriesNumber, a
SeriesInstanceUID, or a substring of the SeriesDescription. `--dry-run` reports
what would be written without writing it and `--json` emits the summary for a
script to read. `dcmsort --help` lists everything.

Exit status is 0 when nothing failed - including a run where the rules fitted no
series at all - and 1 when a file could not be read or written.

### Getting the command

From a checkout, `node src/cli/cli.js ...`, `npm run cli -- ...`, or
`make cli ARGS="list --folder /data"`.

The packaged apps ship it too. A bundle already carries a complete Node runtime -
its own Electron binary, which runs any script as plain Node - so the CLI needs
no second runtime and cannot drift from the app it ships with.

```bash
# macOS
/Applications/dcmsort.app/Contents/Resources/dcmsort apply --rules r.json --folder /data --out /out
sudo ln -s /Applications/dcmsort.app/Contents/Resources/dcmsort /usr/local/bin/dcmsort   # or: make cli-link
```

```bash
# Linux, from an extracted AppImage or an unpacked build
/opt/dcmsort/resources/dcmsort apply --rules r.json --folder /data --out /out
sudo ln -s /opt/dcmsort/resources/dcmsort /usr/local/bin/dcmsort
```

```bat
rem Windows
"C:\Program Files\dcmsort\resources\dcmsort.cmd" apply --rules r.json --folder D:\data --out D:\out
```

Add that `resources` folder to `PATH` for a bare `dcmsort` on Windows. The same
POSIX launcher serves macOS and Linux; it finds the executable in whichever
place the platform puts it.

## Architecture

```
src/main/       Electron main process: all filesystem and DICOM work
  tags.js       raw DICOM tag keys and the VRs we write
  dicom-io.js   dcmjs read/modify/write, UID generation
  scanner.js    recursive walk + worker_threads pool
  library.js    Exam > Series grouping
  analyze.js    volume and phase detection
  rules.js      range parsing, rule resolution, attribute formulas
  export.js     writing, in place or to a new folder
  ipc.js        the entire main/renderer boundary
src/cli/        headless entry point, same engine, no Electron
src/preload/    contextBridge surface (window.dcmsort)
src/renderer/   vanilla HTML/CSS/JS, no framework, no build step
```

Nothing under `src/main/` imports Electron except `ipc.js` and `main.js`, which is what lets the CLI
and the unit tests drive the same engine under plain Node.

Scan records are heavy and never leave the main process; the renderer receives only the projections
it needs to draw. Headers are parsed with `untilTag` so pixel data is never decoded during a scan,
across a worker pool sized to the machine.

## Development

```bash
make test        # 60 unit tests
make watch       # tests in watch mode
make fixtures    # generate the synthetic test DICOMs (no PHI in the repo)
make smoke       # launch the real app and drive it end to end
make drive       # interactive REPL against the running window
make clean       # remove dist/ and generated fixtures
```

Fixtures are generated rather than committed, once per test run by
`test/global-setup.mjs` - test files run in parallel workers, so generating them
per file would race.

`scripts/drive.mjs` launches the app under Playwright and exposes `click`, `set`, `text`, `ss`,
`eval`, and `stub-dialogs` (which replaces the native file dialogs so export and save/load can be
driven unattended). `npm start -- --open <dir>` also works on its own.

Test fixtures are synthesized by `test/fixtures/generate.js` and cover the structural cases that
matter: a clean matrix, three co-located cohorts in one series, a ragged cohort that must split into
several volumes, a series with no `TemporalPositionIdentifier`, and one with no geometry at all.

### A note on write fidelity

dcmjs re-encodes the whole dataset on write rather than patching bytes in place. `test/dicom-io.test.mjs`
round-trips an unmodified file and asserts every tag and every pixel byte survives. If you hit a
vendor file where that fails, that test is where to reproduce it.
