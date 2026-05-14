/**
 * secrets.js — Reads secrets from AWS Secrets Manager in prod,
 * falls back to process.env (populated by dotenv from .env.local) in dev.
 */

'use strict';

require('dotenv').config({ path: '../.env.local' });

let _cache = null;

async function _loadFromSecretsManager() {
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const res = await client.send(new GetSecretValueCommand({
    SecretId: process.env.AWS_SECRETS_NAME || 'quintar-ops/dev',
  }));
  return JSON.parse(res.SecretString);
}

async function loadSecrets() {
  if (_cache) return _cache;

  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod') {
    try {
      _cache = await _loadFromSecretsManager();
    } catch (err) {
      console.error('Failed to load secrets from Secrets Manager:', err.message);
      throw err;
    }
  } else {
    // Dev: use environment variables (dotenv loaded above)
    _cache = {
      SESSION_SECRET:       process.env.SESSION_SECRET,
      SLACK_BOT_TOKEN:      process.env.SLACK_BOT_TOKEN,
      SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
    };
  }

  return _cache;
}

async function getSecret(key) {
  const secrets = await loadSecrets();
  return secrets[key];
}

module.exports = { loadSecrets, getSecret };
