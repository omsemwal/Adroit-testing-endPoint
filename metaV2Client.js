const https = require('https');
const fs = require('fs');
const querystring = require('querystring');

/**
 * Makes an mTLS POST request to the Meta DSA API.
 * @param {Object} options - Configuration options.
 * @param {string} options.certPath - Path to the client certificate.
 * @param {string} options.keyPath - Path to the client private key.
 * @param {string} options.hostname - API hostname.
 * @param {string} options.endpoint - API endpoint path (without query).
 * @param {Object} options.queryParams - Query parameters as key-value pairs.
 * @returns {Promise<{status: number, body: string, json: object|null}>}
 */
function metaApiRequest({
  certPath,
  keyPath,
  hostname,
  endpoint,
  queryParams
}) {
  return new Promise((resolve, reject) => {
    // Build the query string
    const query = querystring.stringify(queryParams);
    const path = `${endpoint}?${query}`;

    // Read the certificate and key
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);

    const reqOptions = {
      hostname,
      port: 443,
      path,
      method: 'POST',
      cert,
      key,
      // rejectUnauthorized: true, // set to false only for self-signed certs
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          // Not JSON, leave as null
        }
        resolve({
          status: res.statusCode,
          body: data,
          json
        });
      });
    });

    req.on('error', (e) => reject(e));
    req.end();
  });
}

// --- Example Usage ---

(async () => {
  // Customize these parameters as needed
  const params = {
    certPath: './certs/adroit_prod.crt',
    keyPath: './certs/adroit-private.key',
    hostname: 'external-disputes.meta.com',
    endpoint: '/v2/request-for-information/submit/',
    queryParams: {
      reference_number: 'FB-E26J1VJO', //real
      platform: 'Facebook'
    }
  };

  try {
    const result = await metaApiRequest(params);
    console.log('Status:', result.status);
    console.log('Response Body:', result.body);
    console.log('Response JSON:', result.json);
  } catch (err) {
    console.error('Request error:', err);
  }
})();
