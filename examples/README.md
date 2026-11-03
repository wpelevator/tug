# Examples

- [WordPress and MariaDB](wordpress/README.md): a site with scheduled database and content backups.
- Language stacks: minimal file APIs with Redis and S3-compatible storage.
  - [Node.js and PostgreSQL](node/README.md)
  - [Django and PostgreSQL](django/README.md)
  - [Laravel and MariaDB](laravel/README.md)
- [tug.yml](tug.yml): example CLI configuration for a two-node project.

## Language stack examples

The Node.js, Django, and Laravel applications expose the same file API and concentrate on the Tug configuration. Each has an application, a database, Redis, and a separately provisioned S3-compatible bucket.

The web service sends file bytes directly to object storage and records the object key and original filename in the database. Redis caches the file list for 30 seconds; it is disposable and has no backup. No file data is stored on the application container. The application and its dependencies are placed on one node; only the web service has managed ingress.

### Prepare and deploy

Create a project and register an ingress-enabled node named `app` (or change every placement in the Compose file). Set up DNS for the web host. Create a private bucket with an S3-compatible provider and credentials allowed to put, get, and delete objects in that bucket. Set the host, S3 endpoint, bucket, and region in the Compose file. HTTPS is strongly recommended for the S3 endpoint. Path-style S3 requests are enabled. Each example should use its own bucket or dedicated credentials and bucket.

From the chosen example directory, set the secrets listed in its README with `tug secret set NAME`; the CLI reads each value from standard input. Then configure a separate Tug backup repository and deploy:

```sh
# Use separate backup credentials and storage from the application bucket.
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... tug backup destination set s3:https://s3.example.com/backups --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY
tug deploy -f docker-compose.yml
# Run the migration command in the chosen example's README.
```

The web process can report healthy before the migration is run; its health endpoint checks the process, not its dependencies or schema. Run migrations before sending traffic and plan schema changes before upgrading. To build on the operator machine instead, use `tug deploy --build-local`; its architecture must match the node.

### Try it

After migrating, substitute your ingress hostname:

```sh
curl -F 'file=@./hello.txt' https://app.example.com/files
curl https://app.example.com/files
curl https://app.example.com/files/FILE_ID -o downloaded-file
tug backup run db
tug backup list
```

Use the returned ID for the download. Uploads are limited to 5 MiB. These APIs intentionally have no authentication or authorization; anyone who can reach them can upload and download files. Use an access-controlled test environment, and add authentication, validation, rate limiting and appropriate file handling before adapting an example for real users. The Laravel example uses PHP's development server to keep the deployment small; replace it with a production web server for production.

### Backup and restore

Tug schedules a logical database dump daily and can restore it with `tug restore run db --confirm`; first run without `--confirm` to inspect the plan. Store `tug backup password` safely away from the control plane. See [Backups](../docs/backups.md) for destination setup and restore details.

**The database backup does not include the bucket.** Configure bucket versioning and independent backups with your provider, and test restoring both the bucket and database to a coordinated point in time. Writes to the database and object store are not atomic; an interrupted upload or a restore to mismatched times can leave orphaned objects or missing files. Stop uploads during a recovery and reconcile the two stores before reopening traffic. Redis can be discarded; clear it after a restore to avoid stale lists (for example, `tug run redis -- redis-cli FLUSHDB`). Do not use this command if Redis contains anything else.
