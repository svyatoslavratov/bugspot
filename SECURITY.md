# Security

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/svyatoslavratov/bugspot/security/advisories/new),
not in public issues. You will get an answer within a week.

## Verifying releases

Release checksums and container images are signed keylessly with [Sigstore](https://www.sigstore.dev)
by the release workflow:

```sh
cosign verify-blob checksums.txt --bundle checksums.txt.sigstore.json \
  --certificate-identity-regexp '^https://github.com/svyatoslavratov/bugspot/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify ghcr.io/svyatoslavratov/bugspot:v0.3.1 \
  --certificate-identity-regexp '^https://github.com/svyatoslavratov/bugspot/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The images also carry SLSA provenance and an SBOM.

## How bugspot protects its data

- **Access is decided by the service.** The loader asks `/api/v1/session`; a hidden answer carries
  nothing but `visible:false`, and every API call checks permissions again.
- **CSRF.** State-changing browser requests need the `X-Bugspot-Request` header, which another site
  cannot send without passing CORS; cross-site requests from origins outside
  `BUGSPOT_ALLOWED_ORIGINS` are refused by `Sec-Fetch-Site`. Cookies are `HttpOnly` and
  `SameSite=Lax`, `Secure` behind HTTPS.
- **CORS** is off unless origins are listed, and then answers only those origins.
- **Identity providers.** `forward` passes only the listed cookies or headers, only to the
  configured URL, with a timeout. `jwt` requires `exp`, checks the algorithm against the key type
  (no `none`, no HS/RS confusion), issuer and audience. `header` trusts headers only from
  `BUGSPOT_TRUSTED_PROXIES`.
- **Credentials.** Agent tokens and access keys carry 160 random bits; only SHA-256 hashes are
  stored. They can expire and be revoked.
- **Input.** Strict JSON with known fields only and size limits on every field; texts are stored
  and rendered as text, never as HTML. Screenshots are accepted only when their bytes are PNG,
  JPEG or WebP and are served with their own type and `nosniff`.
- **Abuse.** Per-user (or per-address) rate limits for reads and writes; request body limits.
- **The container** is distroless, runs as `nonroot`, works with a read-only filesystem and writes
  only to `/data`.
- **Privacy.** Captured request URLs keep parameter names only; request and response bodies are
  never captured. Logs hold the path only, without queries.
