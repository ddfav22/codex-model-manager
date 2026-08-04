# Vendored Windows build tool

`rcedit-x64.exe` is the Windows x64 resource editor from Electron's `rcedit` project, distributed by the `rcedit` npm package version 5.0.2. It is used only during packaging to embed `electron/assets/app-icon.ico` into the application executable.

- Upstream: `https://github.com/electron/rcedit`
- Binary version: `2.0.0`
- SHA-256: `3E7801DB1A5EDBEC91B49A24A094AAD776CB4515488EA5A4CA2289C400EADE2A`
- License: MIT; see `rcedit-LICENSE.txt`.

The binary is vendored so Windows builds do not depend on electron-builder downloading and extracting the cross-platform `winCodeSign` archive, whose macOS symbolic links require privileges unavailable on some Windows machines.
