---
'@wpelevator/tug': minor
---

Add `build.secrets` and `build.additional_contexts`. `build.secrets` lists project secrets (set with `tug secret set`) that a Dockerfile reads with `RUN --mount=type=secret,id=NAME`; control hands them to BuildKit through its environment, so they are in no image layer, process argument, build error or deployment record. A service that uses them builds on control, not with `--build-local`. `build.additional_contexts` passes named contexts (`COPY --from=name`) and needs `docker buildx` where the image is built; without it the deploy fails with a message that says so.
