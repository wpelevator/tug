---
"@wpelevator/tug": minor
---

Pin published images to registry digests before deployment so rollback and new nodes reuse the same image. Always deliver Tug-built images as saved archives, remove build-registry configuration and node registry tokens, and support private published images through the encrypted TUG_REGISTRY_AUTH project secret.
