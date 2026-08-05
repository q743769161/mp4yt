# Production Deployment Guide

## Prerequisites
- A cloud VPS (Ubuntu 22.04+ recommended) or Kubernetes cluster
- Docker and Docker Compose installed (or Helm for K8s)
- Nginx or Traefik/Caddy for ingress
- DNS configured for your API domain

## Deployment Steps

1. **Clone the repository on your VPS:**
   ```bash
   git clone <your-repo-url> mp4yt
   cd mp4yt
   ```

2. **Configure Environment:**
   ```bash
   cd deploy
   cp .env.example .env
   # Edit .env and set your DOMAIN_NAME (e.g. api.mp4yt.com)
   nano .env
   ```

3. **Start the Infrastructure (via Docker Compose):**
   *(Note: For production, consider using a CI/CD pipeline via GitHub Actions or an Ansible playbook for immutable deployments.)*
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```
   This deploys the `mp4yt-backend` API Gateway, `cobalt` engine, and `watchtower`.

4. **Configure Nginx Reverse Proxy:**
   ```bash
   sudo cp nginx.conf /etc/nginx/sites-available/mp4yt
   sudo ln -s /etc/nginx/sites-available/mp4yt /etc/nginx/sites-enabled/
   # Test and restart Nginx
   sudo nginx -t
   sudo systemctl restart nginx
   ```

5. **Enable HTTPS (SSL):**
   Use Certbot to automatically configure SSL for your domain:
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d api.mp4yt.com
   ```

## Backup & Rollback Procedure

- **Rollback:** In a standard CI/CD pipeline, revert the git commit and trigger the pipeline. For manual rollbacks:
  ```bash
  git checkout <previous-working-commit>
  docker compose -f docker-compose.prod.yml up -d --build
  ```
- **Backup:** The application (both Cobalt and the Node API) is entirely stateless. Maintain your `.env` configuration securely in a secret manager (e.g., AWS Secrets Manager, HashiCorp Vault) and manage Nginx/Ingress configurations via source control.

## Observability & Monitoring
- **Logs:** Pino structured logs are emitted to stdout. It is highly recommended to deploy Promtail/Fluentbit to scrape container logs and forward them to Loki or Elasticsearch.
- **Metrics:** Expose Docker engine metrics to Prometheus for dashboard visualization in Grafana.
