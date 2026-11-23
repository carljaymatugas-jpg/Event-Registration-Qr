'use strict';
/**
 * Local HTTPS Dev Server for Camera Testing (Level 3 - Item 17)
 * Mobile browsers require HTTPS for camera permissions (getUserMedia).
 * This script runs the app with a self-signed TLS cert.
 */
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');

const certDir = path.resolve('./data/certs');
if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });

const keyPath = path.join(certDir, 'dev_key.pem');
const certPath = path.join(certDir, 'dev_cert.pem');

// Generate self-signed cert if missing
if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.log('Generating self-signed certificate for local HTTPS testing...');
  const { privateKey, certificate } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // Self-signed X509 certificate
  const cert = crypto.createX509Certificate({
    key: privateKey,
    subject: '/CN=localhost',
    days: 365
  });

  fs.writeFileSync(keyPath, privateKey);
  fs.writeFileSync(certPath, cert.toString());
  console.log('Generated certificate at data/certs/');
}

const options = {
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath)
};

const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
https.createServer(options, app).listen(HTTPS_PORT, () => {
  console.log(`\n🔒 Local HTTPS server running at https://localhost:${HTTPS_PORT}`);
  console.log(`📱 To test camera from your phone on the same Wi-Fi:`);
  console.log(`   1. Find your computer's local IP (e.g., ipconfig -> 192.168.x.x)`);
  console.log(`   2. Open https://<YOUR_IP>:${HTTPS_PORT} on your phone\n`);
});
