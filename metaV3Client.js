/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Meta DSA Article 21 API — V3 Client
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A complete Node.js client for Meta's DSA Article 21 dispute resolution API.
 * Covers all 7 endpoints with mTLS authentication, input validation,
 * structured error handling, and file attachment support.
 *
 * Usage (as module):
 *   const { MetaV3Client } = require('./metaV3Client');
 *   const client = new MetaV3Client({ certPath: '...', keyPath: '...' });
 *   const result = await client.getDisputeMetadata('FB-123456');
 *
 * Usage (as CLI):
 *   node metaV3Client.js metadata FB-123456
 *   node metaV3Client.js rfi-submit --reference_number FB-123456 --platform Facebook
 *   node metaV3Client.js rfi-status --request_id 123456
 *   (see CLI section at bottom for all commands)
 *
 * Author: Adroit Integration
 * API Version: V3 (March 2026)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const API_HOSTNAME = 'api.external-disputes.meta.com';
const API_BASE_PATH = '/v3';

const PLATFORMS = ['Facebook', 'Instagram', 'Threads', 'Whatsapp', 'Other'];
const RECOMMENDATIONS = ['OVERTURN', 'UPHOLD', 'OTHER'];
const RFI_STATUSES = ['OPEN', 'PENDING', 'CLOSED'];
const REC_STATUSES = ['OPEN', 'PENDING', 'CLOSED'];

const HTTP_STATUS_MESSAGES = {
  200: 'Success',
  400: 'Bad Request — Invalid or missing parameters',
  401: 'Unauthorized — Invalid or missing certificate',
  403: 'Forbidden — Certificate not authorized for this operation',
  404: 'Not Found — Resource does not exist',
  429: 'Too Many Requests — Rate limit exceeded (10,000/hour)',
  500: 'Internal Server Error — Meta side issue',
};

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

class MetaApiError extends Error {
  constructor(statusCode, title, detail, rawBody) {
    super(`[${statusCode}] ${title || HTTP_STATUS_MESSAGES[statusCode] || 'Unknown Error'}: ${detail || ''}`);
    this.name = 'MetaApiError';
    this.statusCode = statusCode;
    this.title = title;
    this.detail = detail;
    this.rawBody = rawBody;
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validators
// ─────────────────────────────────────────────────────────────────────────────

function requireParam(params, name, type) {
  if (params[name] === undefined || params[name] === null || params[name] === '') {
    throw new ValidationError(`Missing required parameter: "${name}"`);
  }
  if (type === 'string' && typeof params[name] !== 'string') {
    throw new ValidationError(`Parameter "${name}" must be a string, got ${typeof params[name]}`);
  }
  if (type === 'int' && (!Number.isInteger(params[name]) || params[name] < 0)) {
    throw new ValidationError(`Parameter "${name}" must be a positive integer, got ${params[name]}`);
  }
}

function validatePlatform(platform) {
  // Normalize common casings
  const normalized = PLATFORMS.find(
    (p) => p.toLowerCase() === String(platform).toLowerCase()
  );
  if (!normalized) {
    throw new ValidationError(
      `Invalid platform "${platform}". Must be one of: ${PLATFORMS.join(', ')}`
    );
  }
  return normalized;
}

function validateRecommendation(rec) {
  const upper = String(rec).toUpperCase();
  if (!RECOMMENDATIONS.includes(upper)) {
    throw new ValidationError(
      `Invalid recommendation "${rec}". Must be one of: ${RECOMMENDATIONS.join(', ')}`
    );
  }
  return upper;
}

function validateTimestamp(ts) {
  const num = Number(ts);
  if (!Number.isInteger(num) || num < 0) {
    throw new ValidationError(`Invalid unix timestamp: "${ts}". Must be a positive integer.`);
  }
  // Sanity: should be after 2020 and not in the far future
  const year2020 = 1577836800;
  const year2030 = 1893456000;
  if (num < year2020 || num > year2030) {
    console.warn(`⚠  Timestamp ${num} looks unusual (resolves to ${new Date(num * 1000).toISOString()}). Proceeding anyway.`);
  }
  return num;
}

function validateUrl(url, paramName) {
  try {
    new URL(url);
  } catch {
    throw new ValidationError(`Invalid URL for "${paramName}": "${url}"`);
  }
  return url;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core HTTP Layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Low-level mTLS request handler.
 * Supports GET (query params) and POST (JSON body or multipart/form-data).
 */
function makeRequest({ cert, key, method, endpoint, queryParams, jsonBody, attachments }) {
  return new Promise((resolve, reject) => {
    let requestPath = `${API_BASE_PATH}${endpoint}`;

    // GET requests: params go in query string
    if (queryParams && Object.keys(queryParams).length > 0) {
      requestPath += '?' + querystring.stringify(queryParams);
    }

    const reqOptions = {
      hostname: API_HOSTNAME,
      port: 443,
      path: requestPath,
      method: method.toUpperCase(),
      cert,
      key,
      headers: {},
    };

    let body = null;

    if (attachments && attachments.length > 0) {
      // ── Multipart/form-data for file uploads ──
      const boundary = `----MetaV3Boundary${crypto.randomBytes(16).toString('hex')}`;
      reqOptions.headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;

      const parts = [];

      // Add JSON fields as form fields
      if (jsonBody) {
        for (const [fieldName, fieldValue] of Object.entries(jsonBody)) {
          if (fieldValue !== undefined && fieldValue !== null) {
            parts.push(
              `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="${fieldName}"\r\n\r\n` +
              `${fieldValue}\r\n`
            );
          }
        }
      }

      // Add file attachments
      let totalSize = 0;
      for (let i = 0; i < attachments.length; i++) {
        const filePath = attachments[i];
        if (!fs.existsSync(filePath)) {
          return reject(new ValidationError(`Attachment file not found: "${filePath}"`));
        }
        const fileData = fs.readFileSync(filePath);
        totalSize += fileData.length;
        if (totalSize > MAX_ATTACHMENT_SIZE) {
          return reject(new ValidationError(
            `Combined attachment size exceeds 10MB limit (current: ${(totalSize / 1024 / 1024).toFixed(1)}MB)`
          ));
        }
        const fileName = path.basename(filePath);
        parts.push(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="doc${i + 1}"; filename="${fileName}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`
        );
        parts.push(fileData);
        parts.push('\r\n');
      }

      parts.push(`--${boundary}--\r\n`);

      // Combine parts into a single buffer
      const bufferParts = parts.map((p) =>
        typeof p === 'string' ? Buffer.from(p, 'utf-8') : p
      );
      body = Buffer.concat(bufferParts);
      reqOptions.headers['Content-Length'] = body.length;

    } else if (jsonBody && method.toUpperCase() === 'POST') {
      // ── JSON body for POST requests ──
      body = JSON.stringify(jsonBody);
      reqOptions.headers['Content-Type'] = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');

        let json = null;
        try {
          json = JSON.parse(rawBody);
        } catch {
          // Response may not be JSON (e.g., HTML error pages)
        }

        // Handle non-200 responses
        if (res.statusCode !== 200) {
          const title = json?.title || null;
          const detail = json?.detail || null;
          return reject(new MetaApiError(res.statusCode, title, detail, rawBody));
        }

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: rawBody,
          json,
        });
      });
    });

    req.on('error', (err) => {
      // Enhance common connection errors
      if (err.code === 'ECONNREFUSED') {
        err.message = `Connection refused by ${API_HOSTNAME}. Check network/firewall. Original: ${err.message}`;
      } else if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
        err.message = `TLS certificate verification failed. Your cert may be expired or invalid. Original: ${err.message}`;
      } else if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        err.message = `Hostname mismatch — cert doesn't match ${API_HOSTNAME}. Original: ${err.message}`;
      }
      reject(err);
    });

    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timed out after 30 seconds'));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MetaV3Client Class
// ─────────────────────────────────────────────────────────────────────────────

class MetaV3Client {
  /**
   * @param {Object} config
   * @param {string} config.certPath - Path to client certificate (.crt)
   * @param {string} config.keyPath  - Path to private key (.key)
   * @param {boolean} [config.isTest=false] - If true, sets is_test on RFI/Recommendation calls
   * @param {boolean} [config.verbose=false] - If true, logs request details to console
   */
  constructor({ certPath, keyPath, isTest = false, verbose = false }) {
    if (!certPath || !keyPath) {
      throw new ValidationError('certPath and keyPath are required');
    }
    if (!fs.existsSync(certPath)) {
      throw new ValidationError(`Certificate file not found: "${certPath}"`);
    }
    if (!fs.existsSync(keyPath)) {
      throw new ValidationError(`Private key file not found: "${keyPath}"`);
    }

    this.cert = fs.readFileSync(certPath);
    this.key = fs.readFileSync(keyPath);
    this.isTest = isTest;
    this.verbose = verbose;

    // Verify cert is PEM format
    const certStr = this.cert.toString('utf-8');
    if (!certStr.includes('-----BEGIN CERTIFICATE-----')) {
      throw new ValidationError('Certificate file does not appear to be in PEM format');
    }
    const keyStr = this.key.toString('utf-8');
    if (!keyStr.includes('-----BEGIN') || !keyStr.includes('KEY-----')) {
      throw new ValidationError('Key file does not appear to be in PEM format');
    }

    if (this.verbose) {
      console.log(`✓ MetaV3Client initialized`);
      console.log(`  Cert: ${certPath}`);
      console.log(`  Key:  ${keyPath}`);
      console.log(`  Mode: ${isTest ? 'TEST' : 'PRODUCTION'}`);
      console.log(`  Host: ${API_HOSTNAME}`);
      console.log('');
    }
  }

  /**
   * Internal: execute a request and return parsed result.
   */
  async _request(method, endpoint, { queryParams, jsonBody, attachments } = {}) {
    if (this.verbose) {
      console.log(`→ ${method.toUpperCase()} ${API_BASE_PATH}${endpoint}`);
      if (queryParams) console.log('  Query:', queryParams);
      if (jsonBody) console.log('  Body:', JSON.stringify(jsonBody, null, 2));
      if (attachments) console.log('  Attachments:', attachments);
      console.log('');
    }

    const result = await makeRequest({
      cert: this.cert,
      key: this.key,
      method,
      endpoint,
      queryParams,
      jsonBody,
      attachments,
    });

    if (this.verbose) {
      console.log(`← ${result.statusCode}`);
      console.log('  Response:', JSON.stringify(result.json, null, 2));
      console.log('');
    }

    return result.json || result.body;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // [1] Dispute Metadata
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * GET /v3/dispute/metadata
   *
   * Check if a dispute reference number is valid and get basic info.
   * Use this before submitting an RFI to verify the case exists.
   *
   * @param {string} referenceNumber - Meta-generated reference (e.g., "FB-123456")
   * @returns {Promise<{is_valid: boolean, decision_submitted?: boolean, platform?: string, policy?: string}>}
   */
  async getDisputeMetadata(referenceNumber) {
    requireParam({ reference_number: referenceNumber }, 'reference_number', 'string');

    return this._request('GET', '/dispute/metadata', {
      queryParams: { reference_number: referenceNumber },
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // [2] Request for Information (RFI)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * POST /v3/request-for-information/submit
   *
   * Submit an RFI using a Meta-generated reference number.
   * This is the standard path when the user provides a reference number.
   *
   * @param {Object} params
   * @param {string} params.reference_number - Meta dispute reference
   * @param {string} params.platform - Facebook | Instagram | Threads | Whatsapp | Other
   * @param {string} [params.additional_context] - Extra info to help Meta
   * @param {string} [params.ods_body_case_id] - Your internal tracking ID
   * @param {boolean} [params.is_hacked_account] - Hacked account flag
   * @param {string[]} [params.attachments] - File paths to attach
   * @returns {Promise<{request_id: number, report_number?: number, status?: string}>}
   */
  async submitRfi({
    reference_number,
    platform,
    additional_context,
    ods_body_case_id,
    is_hacked_account,
    attachments,
    
  }) {
    requireParam({ reference_number }, 'reference_number', 'string');
    requireParam({ platform }, 'platform', 'string');
    platform = validatePlatform(platform);

    const body = {
      reference_number,
      platform,
    };
    if (additional_context) body.additional_context = additional_context;
    if (ods_body_case_id) body.ods_body_case_id = ods_body_case_id;
    if (is_hacked_account !== undefined) body.is_hacked_account = !!is_hacked_account;
    if (this.isTest) body.is_test = true;

    return this._request('POST', '/request-for-information/submit', {
      jsonBody: body,
      attachments,
    });
  }

  /**
   * POST /v3/request-for-information/submit/reporter
   *
   * Submit an RFI for a reporter dispute (no reference number).
   * Use when the user reported someone else's content to Meta.
   *
   * @param {Object} params
   * @param {string} params.reported_content_type - Type of content (post, comment, profile, etc.)
   * @param {string} params.reporter_account_url - URL to reporter's profile
   * @param {string} params.reported_content_url - URL to the reported content
   * @param {number} params.report_timestamp - Unix timestamp of when content was reported
   * @param {string} params.platform - Facebook | Instagram | Threads | Whatsapp | Other
   * @param {number} [params.ip_defamation_report_number] - For IP/defamation cases
   * @param {string} [params.additional_context]
   * @param {string} [params.ods_body_case_id]
   * @param {boolean} [params.is_hacked_account]
   * @param {string[]} [params.attachments]
   * @returns {Promise<{request_id: number, report_number?: number, status?: string}>}
   */
  async submitRfiReporter({
    reported_content_type,
    reporter_account_url,
    reported_content_url,
    report_timestamp,
    platform,
    ip_defamation_report_number,
    additional_context,
    ods_body_case_id,
    is_hacked_account,
    attachments,
  }) {
    requireParam({ reported_content_type }, 'reported_content_type', 'string');
    requireParam({ reporter_account_url }, 'reporter_account_url', 'string');
    requireParam({ reported_content_url }, 'reported_content_url', 'string');
    requireParam({ report_timestamp }, 'report_timestamp', 'int');
    requireParam({ platform }, 'platform', 'string');

    validateUrl(reporter_account_url, 'reporter_account_url');
    validateUrl(reported_content_url, 'reported_content_url');
    report_timestamp = validateTimestamp(report_timestamp);
    platform = validatePlatform(platform);

    const body = {
      reported_content_type,
      reporter_account_url,
      reported_content_url,
      report_timestamp,
      platform,
    };
    if (ip_defamation_report_number !== undefined) body.ip_defamation_report_number = ip_defamation_report_number;
    if (additional_context) body.additional_context = additional_context;
    if (ods_body_case_id) body.ods_body_case_id = ods_body_case_id;
    if (is_hacked_account !== undefined) body.is_hacked_account = !!is_hacked_account;
    if (this.isTest) body.is_test = true;

    return this._request('POST', '/request-for-information/submit/reporter', {
      jsonBody: body,
      attachments,
    });
  }

  /**
   * POST /v3/request-for-information/submit/actor
   *
   * Submit an RFI for an actor dispute (no reference number).
   * Use when Meta enforced on the user's own content.
   *
   * @param {Object} params
   * @param {string} params.content_type - Type of content (post, video, page, etc.)
   * @param {string} params.content_owner_url - URL to the content owner's account
   * @param {number} params.enforcement_timestamp - Unix timestamp of enforcement
   * @param {string} params.platform - Facebook | Instagram | Threads | Whatsapp | Other
   * @param {string} [params.ods_body_case_id]
   * @param {string} [params.additional_context]
   * @param {boolean} [params.is_hacked_account]
   * @param {string[]} [params.attachments]
   * @returns {Promise<{request_id: number, report_number?: number, status?: string}>}
   */
  async submitRfiActor({
    content_type,
    content_owner_url,
    enforcement_timestamp,
    platform,
    ods_body_case_id,
    additional_context,
    is_hacked_account,
    attachments,
  }) {
    requireParam({ content_type }, 'content_type', 'string');
    requireParam({ content_owner_url }, 'content_owner_url', 'string');
    requireParam({ enforcement_timestamp }, 'enforcement_timestamp', 'int');
    requireParam({ platform }, 'platform', 'string');

    validateUrl(content_owner_url, 'content_owner_url');
    enforcement_timestamp = validateTimestamp(enforcement_timestamp);
    platform = validatePlatform(platform);

    const body = {
      content_type,
      content_owner_url,
      enforcement_timestamp,
      platform,
    };
    if (ods_body_case_id) body.ods_body_case_id = ods_body_case_id;
    if (additional_context) body.additional_context = additional_context;
    if (is_hacked_account !== undefined) body.is_hacked_account = !!is_hacked_account;
    if (this.isTest) body.is_test = true;

    return this._request('POST', '/request-for-information/submit/actor', {
      jsonBody: body,
      attachments,
    });
  }

  /**
   * GET /v3/request-for-information/status
   *
   * Check the status of a previously submitted RFI.
   * Poll this until status is "CLOSED", then check download_uri.
   *
   * @param {number} requestId - The request_id from a previous RFI submission
   * @returns {Promise<{status: string, reference_number?: string, ods_body_case_id?: string, download_uri?: string}>}
   */
  async getRfiStatus(requestId) {
    const id = Number(requestId);
    requireParam({ request_id: id }, 'request_id', 'int');

    return this._request('GET', '/request-for-information/status', {
      queryParams: { request_id: id },
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // [3] Recommendations
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * POST /v3/recommendation/submit
   *
   * Submit Adroit's recommendation on a dispute.
   * IMPORTANT: You must have submitted an RFI first and use its report_number.
   *
   * @param {Object} params
   * @param {string} params.platform - Facebook | Instagram | Threads | Whatsapp | Other
   * @param {string} params.recommendation - OVERTURN | UPHOLD | OTHER
   * @param {string} params.recommendation_reasoning - Explanation (required, must be substantive)
   * @param {number} params.rfi_report_number - Report number from a previous RFI response
   * @param {string} [params.reference_number] - Meta reference number if available
   * @param {string} [params.profile_url] - User's profile URL
   * @param {string} [params.content_url] - Content URL
   * @param {string} [params.additional_context]
   * @param {number} [params.enforcement_timestamp]
   * @param {string} [params.ods_body_case_id]
   * @param {string[]} [params.attachments]
   * @returns {Promise<{request_id: number, report_number?: number, ods_body_case_id?: string, status?: string}>}
   */
  async submitRecommendation({
    platform,
    recommendation,
    recommendation_reasoning,
    rfi_report_number,
    reference_number,
    profile_url,
    content_url,
    additional_context,
    enforcement_timestamp,
    ods_body_case_id,
    attachments,
  }) {
    requireParam({ platform }, 'platform', 'string');
    requireParam({ recommendation }, 'recommendation', 'string');
    requireParam({ recommendation_reasoning }, 'recommendation_reasoning', 'string');
    requireParam({ rfi_report_number }, 'rfi_report_number', 'int');

    platform = validatePlatform(platform);
    recommendation = validateRecommendation(recommendation);

    if (recommendation_reasoning.trim().length < 10) {
      throw new ValidationError(
        'recommendation_reasoning must be substantive (at least 10 characters). ' +
        'Meta requires reasoned decisions per their March 2026 communication.'
      );
    }

    const body = {
      platform,
      recommendation,
      recommendation_reasoning,
      rfi_report_number,
    };
    if (reference_number) body.reference_number = reference_number;
    if (profile_url) {
      validateUrl(profile_url, 'profile_url');
      body.profile_url = profile_url;
    }
    if (content_url) {
      validateUrl(content_url, 'content_url');
      body.content_url = content_url;
    }
    if (additional_context) body.additional_context = additional_context;
    if (enforcement_timestamp !== undefined) {
      body.enforcement_timestamp = validateTimestamp(enforcement_timestamp);
    }
    if (ods_body_case_id) body.ods_body_case_id = ods_body_case_id;
    if (this.isTest) body.is_test = true;

    return this._request('POST', '/recommendation/submit', {
      jsonBody: body,
      attachments,
    });
  }

  /**
   * GET /v3/recommendation/status
   *
   * Check the status of a previously submitted recommendation.
   * Poll until status is "CLOSED" to get Meta's final decision.
   *
   * @param {number} requestId - The request_id from recommendation submission
   * @returns {Promise<{status: string, recommendation?: string, reference_number?: string, decision?: string}>}
   */
  async getRecommendationStatus(requestId) {
    const id = Number(requestId);
    requireParam({ request_id: id }, 'request_id', 'int');

    return this._request('GET', '/recommendation/status', {
      queryParams: { request_id: id },
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Utility: Polling
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Poll an RFI status until it reaches a terminal state.
   *
   * @param {number} requestId
   * @param {Object} [options]
   * @param {number} [options.intervalMs=30000] - Polling interval in ms (default 30s)
   * @param {number} [options.maxAttempts=40] - Max polls before giving up (default ~20 min)
   * @param {function} [options.onPoll] - Callback on each poll: (attempt, status, response) => void
   * @returns {Promise<Object>} Final status response
   */
  async pollRfiStatus(requestId, { intervalMs = 30000, maxAttempts = 40, onPoll } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.getRfiStatus(requestId);
      const status = result.status || result;

      if (onPoll) onPoll(attempt, status, result);

      if (status === 'CLOSED') {
        return result;
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
    throw new Error(`RFI ${requestId} did not reach CLOSED status after ${maxAttempts} attempts`);
  }

  /**
   * Poll a recommendation status until it reaches a terminal state.
   *
   * @param {number} requestId
   * @param {Object} [options]
   * @param {number} [options.intervalMs=60000] - Polling interval (default 60s — decisions take longer)
   * @param {number} [options.maxAttempts=60] - Max polls (default ~60 min)
   * @param {function} [options.onPoll] - Callback on each poll
   * @returns {Promise<Object>} Final status response with Meta's decision
   */
  async pollRecommendationStatus(requestId, { intervalMs = 60000, maxAttempts = 60, onPoll } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.getRecommendationStatus(requestId);
      const status = result.status || result;

      if (onPoll) onPoll(attempt, status, result);

      if (status === 'CLOSED') {
        return result;
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
    throw new Error(`Recommendation ${requestId} did not reach CLOSED status after ${maxAttempts} attempts`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Interface
// ─────────────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║  Meta DSA Article 21 API — V3 Client CLI                                   ║
╚══════════════════════════════════════════════════════════════════════════════╝

USAGE:
  node metaV3Client.js <command> [options]

ENVIRONMENT:
  --test          Use test certificate (default: production)
  --verbose       Log request/response details
  --cert <path>   Custom cert path (default: ./certs/adroit_prod.crt or adroit_test.crt)
  --key <path>    Custom key path  (default: ./certs/adroit-private.key)

COMMANDS:

  metadata
    Check if a reference number is valid.
    --reference_number <ref>            (required)

  rfi-submit
    Submit an RFI with a Meta reference number.
    --reference_number <ref>            (required)
    --platform <platform>               (required)
    --additional_context <text>
    --ods_body_case_id <id>
    --is_hacked_account
    --attach <file1> [--attach <file2>]

  rfi-submit-reporter
    Submit an RFI for a reporter dispute (no reference number).
    --reported_content_type <type>      (required)  e.g., post, comment, profile
    --reporter_account_url <url>        (required)
    --reported_content_url <url>        (required)
    --report_timestamp <unix_ts>        (required)
    --platform <platform>               (required)
    --ip_defamation_report_number <num>
    --additional_context <text>
    --ods_body_case_id <id>
    --is_hacked_account
    --attach <file1> [--attach <file2>]

  rfi-submit-actor
    Submit an RFI for an actor dispute (no reference number).
    --content_type <type>               (required)  e.g., post, video, page
    --content_owner_url <url>           (required)
    --enforcement_timestamp <unix_ts>   (required)
    --platform <platform>               (required)
    --ods_body_case_id <id>
    --additional_context <text>
    --is_hacked_account
    --attach <file1> [--attach <file2>]

  rfi-status
    Check the status of a submitted RFI.
    --request_id <id>                   (required)

  recommend
    Submit a recommendation for a dispute.
    --platform <platform>               (required)
    --recommendation <OVERTURN|UPHOLD|OTHER>  (required)
    --recommendation_reasoning <text>   (required)
    --rfi_report_number <num>           (required)
    --reference_number <ref>
    --profile_url <url>
    --content_url <url>
    --additional_context <text>
    --enforcement_timestamp <unix_ts>
    --ods_body_case_id <id>
    --attach <file1> [--attach <file2>]

  recommend-status
    Check the status of a submitted recommendation.
    --request_id <id>                   (required)

EXAMPLES:
  node metaV3Client.js metadata --reference_number FB-E26J1VJO
  node metaV3Client.js rfi-submit --reference_number FB-E26J1VJO --platform Facebook --test
  node metaV3Client.js rfi-status --request_id 123456
  node metaV3Client.js recommend --platform Facebook --recommendation OVERTURN \\
    --recommendation_reasoning "Content does not violate policy..." \\
    --rfi_report_number 789012 --reference_number FB-E26J1VJO
  node metaV3Client.js recommend-status --request_id 456789

PLATFORMS: Facebook, Instagram, Threads, Whatsapp, Other
`);
}

/**
 * Parse CLI arguments into a key-value object.
 * Supports: --key value, --flag (boolean), and --attach (array).
 */
function parseArgs(argv) {
  const args = {};
  const attachments = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--attach') {
      if (i + 1 < argv.length) {
        attachments.push(argv[++i]);
      }
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true; // boolean flag
      } else {
        args[key] = argv[++i];
      }
    }
  }

  if (attachments.length > 0) {
    args._attachments = attachments;
  }

  return args;
}

/**
 * Main CLI entry point.
 */
async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  // Resolve cert/key paths
  const isTest = !!args.test;
  const certPath = args.cert || (isTest
    ? './certs/adroit_test.crt'
    : './certs/adroit_prod.crt');
  const keyPath = args.key || './certs/adroit-private.key';

  let client;
  try {
    client = new MetaV3Client({
      certPath,
      keyPath,
      isTest,
      verbose: !!args.verbose,
    });
  } catch (err) {
    console.error(`\n✗ Failed to initialize client: ${err.message}\n`);
    process.exit(1);
  }

  try {
    let result;

    switch (command) {
      case 'metadata':
        result = await client.getDisputeMetadata(args.reference_number);
        break;

      case 'rfi-submit':
        result = await client.submitRfi({
          reference_number: args.reference_number,
          platform: args.platform,
          additional_context: args.additional_context,
          ods_body_case_id: args.ods_body_case_id,
          is_hacked_account: args.is_hacked_account === true || args.is_hacked_account === 'true',
          attachments: args._attachments,
        });
        break;

      case 'rfi-submit-reporter':
        result = await client.submitRfiReporter({
          reported_content_type: args.reported_content_type,
          reporter_account_url: args.reporter_account_url,
          reported_content_url: args.reported_content_url,
          report_timestamp: Number(args.report_timestamp),
          platform: args.platform,
          ip_defamation_report_number: args.ip_defamation_report_number
            ? Number(args.ip_defamation_report_number)
            : undefined,
          additional_context: args.additional_context,
          ods_body_case_id: args.ods_body_case_id,
          is_hacked_account: args.is_hacked_account === true || args.is_hacked_account === 'true',
          attachments: args._attachments,
        });
        break;

      case 'rfi-submit-actor':
        result = await client.submitRfiActor({
          content_type: args.content_type,
          content_owner_url: args.content_owner_url,
          enforcement_timestamp: Number(args.enforcement_timestamp),
          platform: args.platform,
          ods_body_case_id: args.ods_body_case_id,
          additional_context: args.additional_context,
          is_hacked_account: args.is_hacked_account === true || args.is_hacked_account === 'true',
          attachments: args._attachments,
        });
        break;

      case 'rfi-status':
        result = await client.getRfiStatus(args.request_id);
        break;

      case 'recommend':
        result = await client.submitRecommendation({
          platform: args.platform,
          recommendation: args.recommendation,
          recommendation_reasoning: args.recommendation_reasoning,
          rfi_report_number: Number(args.rfi_report_number),
          reference_number: args.reference_number,
          profile_url: args.profile_url,
          content_url: args.content_url,
          additional_context: args.additional_context,
          enforcement_timestamp: args.enforcement_timestamp
            ? Number(args.enforcement_timestamp)
            : undefined,
          ods_body_case_id: args.ods_body_case_id,
          attachments: args._attachments,
        });
        break;

      case 'recommend-status':
        result = await client.getRecommendationStatus(args.request_id);
        break;

      default:
        console.error(`\n✗ Unknown command: "${command}". Run with --help for usage.\n`);
        process.exit(1);
    }

    // Output
    console.log('\n✓ Response:\n');
    console.log(JSON.stringify(result, null, 2));
    console.log('');

  } catch (err) {
    if (err instanceof MetaApiError) {
      console.error(`\n✗ API Error [${err.statusCode}]`);
      console.error(`  ${HTTP_STATUS_MESSAGES[err.statusCode] || 'Unknown status'}`);
      if (err.title) console.error(`  Title:  ${err.title}`);
      if (err.detail) console.error(`  Detail: ${err.detail}`);
      if (err.statusCode === 429) {
        console.error('  → Wait before retrying. Rate limit: 10,000 requests/hour.');
      }
      if (err.statusCode === 401) {
        console.error('  → Check your certificate. It may be expired or not recognized by Meta.');
      }
      if (err.statusCode === 403) {
        console.error('  → Your certificate is valid but not authorized for this endpoint.');
      }
      console.error('');
    } else if (err instanceof ValidationError) {
      console.error(`\n✗ Validation Error: ${err.message}\n`);
    } else {
      console.error(`\n✗ Error: ${err.message}\n`);
      if (err.code) console.error(`  Error code: ${err.code}`);
    }
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module Exports & CLI Entry
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  MetaV3Client,
  MetaApiError,
  ValidationError,
  API_HOSTNAME,
  PLATFORMS,
  RECOMMENDATIONS,
};

// Run CLI if executed directly
if (require.main === module) {
  main();
}
