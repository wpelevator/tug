FROM alpine:3.21
RUN apk add --no-cache restic mariadb-client tzdata
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod 0755 /usr/local/bin/backup.sh
# Unhealthy when the last successful backup is older than BACKUP_MAX_AGE_HOURS (default 30), so `tug status` shows a stalled or failing job.
HEALTHCHECK --interval=5m --timeout=10s --start-period=10s --retries=1 CMD ["/usr/local/bin/backup.sh", "health"]
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["schedule"]
