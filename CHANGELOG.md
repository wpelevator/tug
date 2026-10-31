# @wpelevator/tug

## 0.1.0

### Minor Changes

- c548ed5: First public release: the `tug` CLI and `tug-node` agent/control entrypoint are published to npm as `@wpelevator/tug`, and the matching Docker image to `ghcr.io/wpelevator/tug`. `control install`, `node install` and `node enroll` now default `--image` to the image for the CLI's own version; `--build-local-image` replaces the old build-and-copy default.
