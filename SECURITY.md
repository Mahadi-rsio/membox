# Security Policy

We take the security of Remember seriously. Thank you for helping us keep the
project and its users safe.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report them privately by emailing:
**[rsioex@gmail.com](mailto:rsioex@gmail.com)**

Please include as much of the following as possible:

- A description of the vulnerability and the impact.
- The affected versions and code locations.
- Steps to reproduce (or a minimal proof of concept).
- Any suggested mitigations.

### What happens next

1. You'll receive an acknowledgment of your report within **5 business days**.
2. We'll investigate and keep you informed of progress.
3. Once the issue is confirmed and a fix is ready, we'll coordinate a
   responsible disclosure timeline before any public announcement.

We ask that you give us reasonable time to fix the issue before disclosing it
publicly.

## Scope

This policy applies to the Remember gateway, its chat UI (`web/`), the landing
page (`memory-core/`), and the documentation.

Out of scope:

- Vulnerabilities in third-party dependencies (please report those to their
  respective maintainers).
- Issues caused by misconfiguration of your own deployment.

## Security best practices for this project

- **Never commit secrets.** API keys and connection strings live in `.dev.vars`
  and Wrangler secrets, which are git-ignored.
- **Keep dependencies updated** to avoid known CVEs.
- **Use the optional `GATEWAY_API_KEY`** to enable bearer auth for clients in
  production.
- **Rotate credentials** if they may have been exposed.

## Supported versions

Security fixes are prioritized for the latest release on `main`. Older
versions may receive patches on a best-effort basis.
