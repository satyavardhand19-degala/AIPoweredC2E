function checkEnv() {
  const missing = [];

  if (process.env.DATA_BACKEND === 'postgres') {
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_HOST) missing.push('DATABASE_URL or POSTGRES_HOST');
  }

  if (process.env.OBJECT_STORE_BACKEND === 's3') {
    if (!process.env.S3_BUCKET) missing.push('S3_BUCKET');
    if (!process.env.S3_ACCESS_KEY_ID) missing.push('S3_ACCESS_KEY_ID');
    if (!process.env.S3_SECRET_ACCESS_KEY) missing.push('S3_SECRET_ACCESS_KEY');
  }

  if (process.env.RATE_LIMIT_BACKEND === 'redis' || process.env.SESSION_BACKEND === 'redis' || process.env.ENABLE_ASYNC_JOBS === '1') {
    if (!process.env.REDIS_HOST && !process.env.REDIS_URL) missing.push('REDIS_HOST or REDIS_URL');
  }

  if (missing.length > 0) {
    console.error('CRITICAL: Missing required environment variables for the selected backends:');
    missing.forEach(m => console.error(` - ${m}`));
    return false;
  }

  console.log('Environment check passed.');
  return true;
}

export { checkEnv };

// If run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!checkEnv()) process.exit(1);
}
