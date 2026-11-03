# Node.js + PostgreSQL

A minimal file API using Redis as a cache and an S3-compatible bucket for file bytes. Follow the shared [deployment and recovery guide](../README.md), then run the migration below.

Secrets to set with `tug secret set`: `DB_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`.

```sh
tug run web -- npm run migrate
```
