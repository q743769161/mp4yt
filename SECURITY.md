# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | ✅ Yes             |

## Reporting a Vulnerability

We take security seriously at **mp4yt**. If you discover a security vulnerability, please report it responsibly.

### How to Report

1. **Email**: Send a detailed report to **security@mp4yt.com**
2. **Subject line**: `[SECURITY] Brief description of the issue`
3. **Do NOT** open a public GitHub issue for security vulnerabilities

### What to Include

- A clear description of the vulnerability
- Steps to reproduce the issue
- The potential impact of the vulnerability
- Any suggested fixes (optional, but appreciated)

### What to Expect

- **Acknowledgment** within **48 hours** of your report
- **Status update** within **5 business days**
- We will work with you to understand and resolve the issue before any public disclosure

### Scope

The following are **in scope** for security reports:

- [mp4yt.com](https://mp4yt.com) — main web application
- API endpoints under `mp4yt.com/api/`
- Cloudflare Worker backend
- Service Worker (`sw.js`)

The following are **out of scope**:

- Third-party services we depend on (e.g., Cobalt API, Cloudflare infrastructure)
- Denial of service (DoS/DDoS) attacks
- Social engineering attacks
- Issues in dependencies that are already publicly known (please check first)

### Safe Harbor

We support safe harbor for security researchers who:

- Make a good faith effort to avoid privacy violations, data destruction, and service disruption
- Only interact with accounts you own or have explicit permission to test
- Do not exploit a vulnerability beyond what is necessary to confirm it
- Report vulnerabilities promptly and do not disclose them publicly before a fix is available

We will not pursue legal action against researchers who follow these guidelines.

## Security Practices

### Data Handling
- **Zero file storage**: mp4yt never stores downloaded media files on any server
- **No user accounts**: No passwords, emails, or personal data are collected
- **No tracking cookies**: Analytics are consent-gated via Google Consent Mode v2
- **Direct CDN streaming**: Videos are streamed directly from the platform's CDN to the user's browser

### Infrastructure
- All traffic is served over **HTTPS** (TLS 1.3)
- The backend runs on **Cloudflare Workers** (edge computing, no persistent server)
- Content Security Policy (CSP) headers are enforced via nonce-based script execution
- Service Worker scope is limited to `/download-stream` interception only

## Contact

For non-security questions, please use [mp4yt.com/contact-us](https://mp4yt.com/contact-us/).
