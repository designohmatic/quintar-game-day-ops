/*
 * PM2 ecosystem entry for the Quintar Game Day Ops backend.
 *
 * IT: merge this `quintar-ops` app entry into the existing
 * /opt/<your-pm2-dir>/ecosystem.config.js on the shared EC2 box.
 * Don't replace the file — append to the apps[] array so your existing
 * app keeps running.
 *
 * Start (after merge):
 *   pm2 start ecosystem.config.js --only quintar-ops
 *   pm2 save
 *
 * Reload after a redeploy:
 *   pm2 reload quintar-ops
 *
 * Notes:
 * - NODE_ENV=production tells server/secrets.js to fetch secrets from
 *   AWS Secrets Manager (quintar-ops/dev) via the EC2 instance role.
 *   Anything other than 'production'/'prod' makes secrets.js try to read
 *   from process.env (which won't have them on the box), so the value
 *   matters even though the secret name still ends in /dev.
 * - SLACK_CHANNEL_ID is non-secret config — channel IDs aren't sensitive.
 * - APPSYNC_* are NOT in this file: they're baked into the frontend bundle
 *   at build time, not read by the backend.
 */

module.exports = {
  apps: [
    {
      name:        'quintar-ops',
      script:      'server/index.js',
      cwd:         '/opt/quintar/game-day-ops',
      instances:   1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV:            'production',
        PORT:                3005,
        LOG_LEVEL:           'info',
        CORS_ALLOWED_ORIGIN: 'https://playground.quintar.ai',
        APP_BASE_URL:        'https://playground.quintar.ai',
        DB_PATH:             '/opt/quintar/game-day-ops/data/ops.db',
        AWS_REGION:          'us-east-1',
        AWS_SECRETS_NAME:    'quintar-ops/dev',
        SLACK_CHANNEL_ID:    'C0A28QULBK2', // #int-gameday-ops
      },
    },
  ],
};
