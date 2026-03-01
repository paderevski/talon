# Talon Portal Skeleton

This workspace now contains a minimal full-stack skeleton based on `launchpad-v2.html`.

## Review of the mockup

The mockup already defines a clean first version of the product in four feature slices:

1. **New Job** – form submission workflow
2. **Repo Browser** – repository preview pane
3. **Job Status** – filterable queue/status table
4. **Results** – output artifact cards

These sections are mapped directly into frontend components and backend routes.

## Project structure

- `frontend/` – React + Vite UI shell
- `backend/` – Express API with in-memory mock data
- `launchpad-v2.html` – original static mockup for design reference

## API skeleton

- `GET /api/health`
- `GET /api/repos/:owner/:repo/tree`
- `GET /api/jobs?status=all|running|queued|completed|failed`
- `POST /api/jobs`
- `GET /api/results`

## Run locally

```bash
npm install
npm run dev
```

This starts:
- frontend on `http://localhost:5173`
- backend on `http://localhost:5174`

### Demo login (local)

The login screen authenticates against a simple backend text file at `backend/src/data/users.txt`.

Current demo credentials:
- username: `jane_smith`
- password: `talon123`

## GitHub PAT setup (current MVP)

Talon now supports saving a GitHub PAT in the backend and using it for GitHub API calls.

### How it works

- User pastes PAT in the **GitHub Credentials** panel.
- Frontend sends token to backend with `x-talon-user` set to the logged-in Talon username.
- Backend validates token (`GET https://api.github.com/user`).
- Backend stores token encrypted-at-rest in `backend/src/data/githubCredentials.json`.
- Token can be replaced or deleted from the same UI.

### Encryption key (important)

Set `TALON_CREDENTIALS_KEY` for backend in every non-dev environment.

Example for systemd service:

```ini
Environment=TALON_CREDENTIALS_KEY=change-this-to-a-strong-secret
```

If not set, backend falls back to a development default key.

### API endpoints

- `GET /api/github-credentials` → token status (`hasToken`, `tokenLast4`, `updatedAt`)
- `PUT /api/github-credentials` with `{ "token": "..." }` → validate + save/replace token
- `DELETE /api/github-credentials` → delete saved token
- `GET /api/github-credentials/repos/:username` → public repos list (uses saved PAT if present)

These endpoints expect request header `x-talon-user` so credentials are scoped per Talon user.

### Security notes

- Do not log PAT values in backend logs.
- Restrict file permissions for `backend/src/data/githubCredentials.json` (service user only).
- Use a strong, unique `TALON_CREDENTIALS_KEY` per environment.
- Rotate PATs regularly and delete unused tokens.
- If you change `TALON_CREDENTIALS_KEY`, previously stored encrypted tokens must be re-saved.

### End-user guide: Create a GitHub PAT

This section is for Talon users who just need to connect GitHub.

1. Sign in to GitHub.
2. Open **Settings**.
3. In the left menu, open **Developer settings**.
4. Open **Personal access tokens**.
5. Choose **Fine-grained tokens** (recommended) and click **Generate new token**.
6. Select your account/organization, set an expiration date, and add a name (for example, `talon-access`).
7. Grant minimum permissions for Talon read access:
	- **Repository permissions** → **Contents: Read-only**
	- **Repository permissions** → **Metadata: Read-only**
8. Click **Generate token**.
9. Copy the token immediately (GitHub only shows it once).

### End-user guide: Add PAT in Talon

1. Log in to Talon.
2. Open **GitHub Credentials** from the left nav (or user menu).
3. Paste your token into **GitHub Personal Access Token (PAT)**.
4. Click **Save Token**.
5. You should see token status updated (masked suffix like `...abcd`).

If your token expires or you rotate it, paste the new token and click **Replace Token**.
If you no longer want Talon to use it, click **Delete Token**.

## Deploy (AWS, single EC2 instance)

If it has been a while, this is the simplest production setup for this repo:
- build the React app once
- run the Node backend as a service
- let Nginx serve frontend static files and proxy `/api/*` to Node

This works well with the current frontend API client because it calls relative paths like `/api/jobs`.

### 1) Launch and prepare an EC2 instance

Use Ubuntu 22.04/24.04, open ports `22`, `80`, `443`, and point your domain DNS to the instance.

Install runtime packages:

```bash
sudo apt update
sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2) Copy project and install deps

```bash
git clone <your-repo-url> talon
cd talon
npm ci
```

### 3) Build frontend assets

```bash
npm run build
```

This creates `frontend/dist`.

### 4) Run backend as a system service

Create `/etc/systemd/system/talon-backend.service`:

```ini
[Unit]
Description=Talon Backend
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/talon
Environment=NODE_ENV=production
Environment=PORT=5174
ExecStart=/usr/bin/npm run start --workspace backend
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now talon-backend
sudo systemctl status talon-backend
```

### 5) Configure Nginx

Create `/etc/nginx/sites-available/talon`:

```nginx
server {
	listen 80;
	server_name your-domain.com;

	root /home/ubuntu/talon/frontend/dist;
	index index.html;

	location / {
		try_files $uri /index.html;
	}

	location /api/ {
		proxy_pass http://127.0.0.1:5174/api/;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_set_header X-Real-IP $remote_addr;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
	}
}
```

Enable site and reload:

```bash
sudo ln -s /etc/nginx/sites-available/talon /etc/nginx/sites-enabled/talon
sudo nginx -t
sudo systemctl reload nginx
```

### 6) Add HTTPS (recommended)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### 7) Deploy updates

For each new deploy:

```bash
cd /home/ubuntu/talon
git pull
npm ci
npm run build
sudo systemctl restart talon-backend
sudo systemctl reload nginx
```

### Notes

- The backend currently uses in-memory mock data (`backend/src/data/mockData.js`), so data resets when the service restarts.
- If you later split frontend/backend into separate hosts, update frontend API calls or add a dedicated API base URL.

## Next build steps

- Replace in-memory data with a database (`jobs`, `artifacts`, `repositories`)
- Add auth/session middleware
- Connect real Git provider APIs
- Add job orchestration worker + queue integration
- Add artifact storage integration (S3/local)
