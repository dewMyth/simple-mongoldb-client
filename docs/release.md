# Releasing

1. Bump `version` in package.json (e.g. `0.2.0`), commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **Release** workflow (`.github/workflows/release.yml`) builds on macOS, Windows and Linux,
   runs the smoke test (`tests/e2e/smoke.spec.ts`: connect with a saved password, query, edit,
   export, shell) against each packaged app, then publishes a GitHub Release with the installers
   and `SHA256SUMS.txt`. The tag must match package.json's version.

Locally: `npm run dist` builds the installer for the current OS into `release/`. To smoke-test a
package: `E2E_EXECUTABLE="<path to the app's executable>" npx playwright test smoke`.

## Targets

| OS      | Target                       | Notes                                                        |
| ------- | ---------------------------- | ------------------------------------------------------------ |
| macOS   | dmg, universal (arm64 + x64) | Native modules are merged per architecture (`x64ArchFiles`). |
| Windows | NSIS installer, x64          | Per-user or per-machine, choice of folder.                   |
| Linux   | AppImage, x64                | Saved passwords need a Secret Service keyring.               |

`asarUnpack` keeps the mongosh worker package and every `.node` file outside the asar: the shell's
worker thread and native modules must be real files. ssh2's optional native ciphers are left out (it
falls back to Node's crypto), so every architecture runs the same code.

## Code signing (not set up yet)

The installers are currently unsigned. To sign, add these repository secrets and remove
`identity: null` from `electron-builder.yml`:

**macOS (signing + notarization)** needs an Apple Developer ID ($99/year):

- `CSC_LINK`: base64 of the "Developer ID Application" certificate exported as .p12;
  `CSC_KEY_PASSWORD`: its password.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization (electron-builder
  notarizes automatically when these are set; add `hardenedRuntime: true` under `mac:`).
- Pass them as `env:` to the "Build installers" step and drop `CSC_IDENTITY_AUTO_DISCOVERY`.

**Windows** needs an OV/EV code-signing certificate (or Azure Trusted Signing):

- `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` for a .pfx, or the `azureSignOptions` config for Trusted
  Signing. EV certificates live on hardware tokens and need a cloud signing service in CI.

**Linux** AppImages are not signed; the checksums file is the integrity check.

## Auto-update (not enabled)

`electron-updater` with GitHub Releases would work with the existing release workflow (publish the
`latest*.yml` files too), but macOS refuses to update unsigned apps, so it waits for signing.
