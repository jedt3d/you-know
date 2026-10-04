# Self-hosting on a Linux server (SSH deploy from GitHub)

The app runs from the exact same code as the Cloudflare Worker: a Node
server (`server/`) shims D1 → SQLite and Durable Objects → in-process
session objects with state persisted to SQLite, so live games even survive
a server restart. The full e2e suite passes against both runtimes.

The **Self-host deploy (manual)** workflow (Actions → Run workflow) builds,
tests, rsyncs the bundle to your server over SSH, runs `npm ci --omit=dev`,
restarts the systemd service and health-checks it. Releases deploy to
Cloudflare instead (see the README) — this path is opt-in whenever you want
your own box.

## One-time server setup

Run as root on the server (adjust paths/tokens to taste):

```bash
# Node 22+ and rsync
apt-get update && apt-get install -y nodejs rsync   # or use nodesource/distrobox for a recent Node
# If better-sqlite3 has no prebuilt binary for your platform you'll also need:
#   apt-get install -y build-essential python3

# Dedicated user + directories
useradd --system --home /opt/you-know --shell /usr/sbin/nologin you-know
mkdir -p /opt/you-know /var/lib/you-know
chown -R you-know:you-know /opt/you-know /var/lib/you-know

# Service
cp /path/to/repo/deploy/you-know.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable you-know
```

The deploy user (the one GitHub Actions logs in as) needs:
- write access to `/opt/you-know` (e.g. `chown -R deploy-user /opt/you-know`),
- passwordless sudo **only** for the service:
  `echo "deploy-user ALL=(root) NOPASSWD: /bin/systemctl restart you-know, /bin/systemctl status you-know, /bin/cp /opt/you-know/deploy/you-know.service /etc/systemd/system/you-know.service, /bin/systemctl daemon-reload" > /etc/sudoers.d/you-know-deploy`
  (visudo-check that line), or grant broader sudo if that's easier for you.

## GitHub configuration

Generate a dedicated deploy key (no passphrase) and add the public half to
the server's `~/.ssh/authorized_keys`:

```bash
ssh-keygen -t ed25519 -f you-know-deploy -N ''
ssh-copy-id -i you-know-deploy.pub deploy-user@your-server
```

Then in the repo → **Settings → Secrets and variables → Actions**:

| Kind    | Name            | Value                                    |
|---------|-----------------|------------------------------------------|
| Secret  | `SSH_HOST`      | server hostname or IP                    |
| Secret  | `SSH_USER`      | deploy user on the server                |
| Secret  | `SSH_PRIVATE_KEY` | contents of `you-know-deploy` (private) |
| Variable (optional) | `SSH_PORT`   | SSH port (default `22`)     |
| Variable (optional) | `DEPLOY_DIR` | deploy path (default `/opt/you-know`) |

## Deploying

- Publish a release (`gh release create v0.1.1 …`) → the workflow runs.
- Or run it manually: Actions → **Deploy to server on release** → Run workflow.

The app listens on `127.0.0.1:8787` behind systemd (`you-know.service`);
put your TLS-terminating reverse proxy in front (WebSocket upgrade included):

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

Data lives in one SQLite file (`YK_DB_PATH`, default `/var/lib/you-know/db.sqlite`).
Back it up and you've backed up everything.
