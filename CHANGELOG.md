# Changelog

All notable changes to Hoply are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The marketing version (e.g. `0.1.0`) tracks user-visible releases. The build
number (e.g. `(1)`) is monotonically incremented for every upload to App Store
Connect across all marketing versions.

## [Unreleased]

## [0.1.3] - 2026-10-27

### Added

- Unsigned iPhone/iPad IPA packaging for AltStore Classic, with an optional resource compiler fallback for local Xcode platform issues.

### Fixed

- Updated the bundled `@rhwp/core` from 0.7.13 to 0.8.7 to correct overlapping inline tables and page breaks in complex HWP forms.
- Scoped SVG IDs and fragment references per page so inline pages cannot clip content using another page's definitions.
- Fitted terminal glyph overhangs to the final SVG cell viewport, correcting right-edge text clipping in nested HWP forms while retaining stored line breaks.

## [0.1.2] - 2026-05-31

### Added
- Ask for an App Store rating after several successful document opens.

### Changed
- Updated App Store metadata source text for better HWP / HWPX viewer discoverability.

## [0.1.1] - 2026-05-17

### Internal
- Pipeline validation build. Exercises the Xcode Cloud workflow end-to-end with the version bump script and tag-triggered release. No user-visible changes from 0.1.0.
- Build 3 (2026-05-18): re-uploaded after switching the Xcode Cloud workflow's Distribution Preparation away from "TestFlight (Internal Testing Only)" so the binary is App Store submission-eligible. No source changes vs. build 2.

## [0.1.0] - 2026-05-16

### Added
- Initial App Store release: read-only HWP / HWPX document viewer.
- Open `.hwp` and `.hwpx` files via Files, Open-In, or the in-app document browser.
- Local rendering through a bundled `@rhwp/core` viewer inside `WKWebView`.
- Share original document or export as PDF.
- AirPrint support.
- Quick Look preview extension (`HoplyQuickLook`) for `.hwp` and `.hwpx` in Files and other system surfaces.

[Unreleased]: https://github.com/dayo05/Hoply/compare/v0.1.3-5...HEAD
[0.1.3]: https://github.com/dayo05/Hoply/tree/v0.1.3-5
[0.1.2]: https://github.com/chkwon/Hoply/releases/tag/v0.1.2-4
[0.1.1]: https://github.com/chkwon/Hoply/releases/tag/v0.1.1
[0.1.0]: https://github.com/chkwon/Hoply/releases/tag/v0.1.0
