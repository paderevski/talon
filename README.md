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
