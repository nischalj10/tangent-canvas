# Product artwork

The product mark is user-supplied artwork: a brown branching emblem with a cream background and a transparent companion. Both originals are preserved byte for byte.

| Asset | Dimensions | Alpha | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| `logo-cream.png` | 1254 × 1254 | No | 1,098,904 | `149f626536d2f98daf180c1d0e63fa4c38ef351108cc2c6a1c182b2952659520` |
| `logo-transparent.png` | 1254 × 1254 | Yes | 286,678 | `b6cc838d87b7bec275d728bbe48c211ba881d6713c9b6f1f9ca8629a78df38d0` |

`logo-transparent.png` supplies inline product marks within the app. The derived `icon.png` supplies the Electron window and running Dock icon; `icon.icns` supplies the packaged macOS application icon.

Regenerate application icons on macOS with `npm run icons`. The script places the exact transparent artwork on an 824 × 824 rounded cream tile within a transparent 1024 × 1024 canvas, with a subtle shadow and border. This padding makes the legacy PNG/ICNS icon match the scale of neighboring Dock icons. The mark itself is not redrawn or cropped.

`icon.iconset` contains the standard macOS resolutions, resized from the framed `icon.png` with `sips`; `iconutil` builds `icon.icns` from those images. The generated iconset directory is ignored by Git.
