import crypto from 'crypto';
import { jwtSign, jwtVerify } from './tokens.js';
import { logger } from './logger.js';
import { randomUUID } from 'crypto';
import { createAtlassianAuthUrl, getAtlassianConfig, extractAtlassianCallbackParams, exchangeCodeForAtlassianTokens } from './atlassian-auth-code-flow.js';


/**
 * Functions are ordered by their usage in the flow
 */

/**
 * OAuth Metadata Endpoint
 * Provides OAuth server configuration for clients
 */
export function oauthMetadata(req, res) {
  console.log('Received request for OAuth metadata');
  res.json({
    issuer: process.env.VITE_AUTH_SERVER_URL,
    authorization_endpoint: process.env.VITE_AUTH_SERVER_URL + '/authorize',
    token_endpoint: process.env.VITE_AUTH_SERVER_URL + '/access-token',
    registration_endpoint: process.env.VITE_AUTH_SERVER_URL + '/register',
    code_challenge_methods_supported: ['S256'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['read:jira-work', 'offline_access'],
  });
}

/**
 * OAuth 2.0 Protected Resource Metadata (RFC9728) for MCP discovery
 * Provides metadata about the protected resource for OAuth clients
 */
export function oauthProtectedResourceMetadata(req, res) {
  console.log('🔍 OAuth Protected Resource Metadata requested!', {
    headers: req.headers,
    query: req.query,
  });
  const baseUrl = process.env.VITE_AUTH_SERVER_URL;
  const metadata = {
    resource: baseUrl,
    authorization_servers: [`${baseUrl}/.well-known/oauth-authorization-server`],
    bearer_methods_supported: ['header', 'query'],
    resource_documentation: `${baseUrl}`,
    scopes_supported: ['read:jira-work', 'offline_access'],
    scope_documentation: {
      'read:jira-work': 'Access to read Jira issues and sites',
      offline_access: 'Refresh token access',
    },
  };
  res.json(metadata);
}

/**
 * Dynamic Client Registration Endpoint (RFC7591)
 * Allows MCP clients to register themselves dynamically
 */
export function register(req, res) {
  console.log('Received dynamic client registration request:', req.body);

  try {
    const {
      redirect_uris = [],
      grant_types = ['authorization_code'],
      response_types = ['code'],
      client_name = 'MCP Client',
      token_endpoint_auth_method = 'none',
    } = req.body;

    // For MCP clients, we'll generate a simple client ID
    // In production, you'd want to store this in a database
    const clientId = `mcp_${randomUUID()}`;

    // Validate redirect URIs (MCP clients should use vscode:// scheme)
    const validRedirectUris = redirect_uris.filter(
      (uri) => uri.startsWith('vscode://') || uri.startsWith('http://localhost'),
    );

    if (validRedirectUris.length === 0) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'At least one valid redirect URI is required',
      });
    }

    // Return client registration response
    res.json({
      client_id: clientId,
      client_name,
      redirect_uris: validRedirectUris,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // For public clients (like VS Code), no client_secret is issued
    });

    logger.info(`Dynamic client registered: ${clientId} for ${client_name}`);
  } catch (error) {
    logger.error('Client registration error:', error);
    res.status(500).json({
      error: 'server_error',
      error_description: 'Failed to register client',
    });
  }
}

/**
 * Authorization Entry Point with PKCE
 * Initiates the OAuth flow by redirecting to Atlassian
 */
export function authorize(req, res) {
  // Get parameters from query (sent by MCP client)
  const mcpClientId = req.query.client_id; // VS Code's client ID
  const mcpRedirectUri = req.query.redirect_uri; // VS Code's redirect URI
  const mcpScope = req.query.scope;
  const responseType = req.query.response_type || 'code';
  const mcpState = req.query.state; // Use MCP client's state
  const mcpCodeChallenge = req.query.code_challenge; // MCP client's PKCE challenge
  const mcpCodeChallengeMethod = req.query.code_challenge_method;
  const mcpResource = req.query.resource; // MCP resource parameter (RFC 8707)

  console.log('GET /authorize request from MCP client:', {
    mcpClientId,
    mcpRedirectUri,
    mcpScope,
    responseType,
    mcpState,
    mcpCodeChallenge,
    mcpCodeChallengeMethod,
    mcpResource,
    queryParams: req.query,
  });

  // Use MCP client's PKCE parameters if provided, otherwise generate our own (fallback)
  let codeChallenge, codeChallengeMethod;
  let codeVerifier = null; // We don't store the verifier when using MCP's PKCE

  if (mcpCodeChallenge && mcpCodeChallengeMethod) {
    // Use the MCP client's PKCE parameters
    codeChallenge = mcpCodeChallenge;
    codeChallengeMethod = mcpCodeChallengeMethod;
    console.log('Using MCP client PKCE parameters');
  } else {
    // Generate our own PKCE parameters (fallback for non-MCP clients)
    codeVerifier = generateCodeVerifier();
    codeChallenge = generateCodeChallenge(codeVerifier);
    codeChallengeMethod = 'S256';
    console.log('Generated our own PKCE parameters');
  }

  // Store MCP client info in session for later use in callback
  req.session.codeVerifier = codeVerifier; // Will be null if using MCP client's PKCE
  req.session.state = mcpState; // Store the MCP client's state
  req.session.mcpClientId = mcpClientId;
  req.session.mcpRedirectUri = mcpRedirectUri; // This is VS Code's callback URI
  req.session.mcpScope = mcpScope;
  req.session.mcpResource = mcpResource; // Store the resource parameter
  req.session.usingMcpPkce = !codeVerifier; // Flag to indicate if we're using MCP's PKCE

  console.log('Storing in session:', {
    state: mcpState,
    codeVerifier: codeVerifier ? 'present' : 'null (using MCP PKCE)',
    mcpClientId,
    mcpRedirectUri,
    mcpResource,
    usingMcpPkce: !codeVerifier,
  });

  // Build URL parameters, omitting state if it's undefined
  const url = createAtlassianAuthUrl({
    codeChallenge,
    codeChallengeMethod,
    state: mcpState,
    responseType,
  });

  console.log('Redirecting to Atlassian:', url);
  res.redirect(url);
}

/**
 * OAuth Callback Handler
 * Handles the callback from Atlassian and exchanges code for tokens
 */
export async function callback(req, res) {
  const { code, state, normalizedState } = extractAtlassianCallbackParams(req);

  console.log('OAuth callback received:', {
    code: code ? 'present' : 'missing',
    state,
    sessionState: req.session.state,
    sessionData: {
      codeVerifier: req.session.codeVerifier ? 'present' : 'missing',
      mcpClientId: req.session.mcpClientId,
      mcpRedirectUri: req.session.mcpRedirectUri,
    },
  });

  // State validation: both should be undefined or both should match
  const stateMatches = normalizedState === req.session.state;

  if (!code || !stateMatches) {
    console.error('State or code validation failed:', {
      hasCode: !!code,
      stateMatch: stateMatches,
      receivedState: state,
      normalizedState,
      expectedState: req.session.state,
    });
    return res.status(400).send('Invalid state or code');
  }
  const mcpRedirectUri = req.session.mcpRedirectUri;
  const usingMcpPkce = req.session.usingMcpPkce;

  // If we're using MCP's PKCE, we can't do the token exchange here
  // because we don't have the code verifier. Instead, we need to pass
  // the authorization code back to the MCP client so it can complete the exchange.
  if (usingMcpPkce && mcpRedirectUri) {
    console.log('Using MCP PKCE - redirecting code back to MCP client');

    // Clear session data
    delete req.session.codeVerifier;
    delete req.session.state;
    delete req.session.mcpClientId;
    delete req.session.mcpRedirectUri;
    delete req.session.mcpScope;
    delete req.session.mcpResource;
    delete req.session.usingMcpPkce;

    // Redirect back to MCP client with the authorization code
    const redirectUrl = `${mcpRedirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(normalizedState)}`;
    console.log('Redirecting to MCP client with auth code:', redirectUrl);
    return res.redirect(redirectUrl);
  }

  // If we reach here, it means we have an invalid state:
  // - No MCP redirect URI, or
  // - Not using MCP PKCE (which shouldn't happen with MCP clients)
  console.error('Invalid callback state:', {
    usingMcpPkce,
    mcpRedirectUri: mcpRedirectUri ? 'present' : 'missing',
  });
  
  return res.status(400).send('Invalid OAuth callback state - missing redirect URI or invalid PKCE configuration');
}

/**
 * OAuth token endpoint for MCP clients (POST)
 * Handles the token exchange for authorization code grant type
 */
export async function accessToken(req, res) {
  console.log('OAuth token exchange request:', {
    body: req.body,
    contentType: req.headers['content-type'],
  });

  try {
    const { grant_type, code, client_id, code_verifier, resource } = req.body;

    if (grant_type !== 'authorization_code') {
      return res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: 'Only authorization_code grant type is supported',
      });
    }

    if (!code) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing authorization code',
      });
    }

    if (!code_verifier) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing code_verifier for PKCE',
      });
    }

    // Exchange the authorization code for Atlassian tokens
    let tokenData;
    try {
      tokenData = await exchangeCodeForAtlassianTokens({ 
        code, 
        codeVerifier: code_verifier 
      });
    } catch (error) {
      console.error('Atlassian token exchange failed:', error.message);
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Authorization code is invalid or expired',
      });
    }

    // Get config for creating JWT
    const ATLASSIAN_CONFIG = getAtlassianConfig();

    // Create JWT with embedded Atlassian token
    const jwt = await jwtSign({
      sub: 'user-' + randomUUID(),
      iss: process.env.VITE_AUTH_SERVER_URL,
      aud: resource || process.env.VITE_AUTH_SERVER_URL, // Use resource parameter if provided
      scope: ATLASSIAN_CONFIG.scopes,
      atlassian_access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
    });

    console.log('OAuth token exchange successful for client:', client_id);

    // Return OAuth-compliant response
    return res.json({
      access_token: jwt,
      token_type: 'Bearer',
      expires_in: 3600, // 1 hour
      scope: ATLASSIAN_CONFIG.scopes,
    });
  } catch (error) {
    console.error('OAuth token exchange error:', error);
    res.status(500).json({
      error: 'server_error',
      error_description: 'Internal server error during token exchange',
    });
  }
}

// === Helper Functions ===

/**
 * Generate a cryptographically secure code verifier for PKCE
 * @returns {string} Base64URL-encoded code verifier
 */
export function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate a code challenge from a code verifier using SHA256
 * @param {string} codeVerifier - The code verifier to hash
 * @returns {string} Base64URL-encoded code challenge
 */
export function generateCodeChallenge(codeVerifier) {
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  return Buffer.from(hash).toString('base64url');
}