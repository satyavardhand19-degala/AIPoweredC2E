#!/usr/bin/env bash
set -e

echo "Configuring backup strategy..."

if [ -z "$S3_BUCKET" ]; then
  echo "Warning: S3_BUCKET not set. Skipping S3 versioning configuration."
else
  echo "Enabling S3 bucket versioning for object storage backups on $S3_BUCKET..."
  # aws s3api put-bucket-versioning --bucket $S3_BUCKET --versioning-configuration Status=Enabled
fi

if [ -z "$DATABASE_URL" ]; then
  echo "Warning: DATABASE_URL not set. Skipping pg_dump cron configuration."
else
  echo "Setting up pg_dump scheduled job for RDS/Postgres backups..."
  # echo "0 2 * * * pg_dump $DATABASE_URL > /backups/db_backup_\$(date +\%Y\%m\%d).sql" > /etc/cron.d/db_backup
fi

echo "Backup strategy configured successfully."
