# Reality check

Local source, native Workerd tests, deployed preview checks and production behavior are separate evidence levels. No production release, mainnet transaction or live user migration belongs to the foundation bootstrap.

The preview stage is now deployed and health/document probes are verified. GitHub Actions has a preview deploy workflow, but its Cloudflare API token secret is not configured yet; direct deployment from the authorized build box is the current live evidence.
