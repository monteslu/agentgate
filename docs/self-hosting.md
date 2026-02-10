# Self-Hosting

## Basic Setup

```bash
npm install
npm start
```

Runs on port 3050 by default. Set `PORT` environment variable to change.

## systemd (Linux)

Create `/etc/systemd/system/agentgate.service`:

```ini
[Unit]
Description=agentgate API gateway
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/agentgate
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
Environment=PORT=3050
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable agentgate
sudo systemctl start agentgate
```

## Docker

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3050
CMD ["node", "src/index.js"]
```

```bash
docker build -t agentgate .
docker run -d -p 3050:3050 -v ./data.db:/app/data.db agentgate
```

## PM2

```bash
npm install -g pm2
pm2 start src/index.js --name agentgate
pm2 save
pm2 startup
```

## Remote Access

### hsync

Built-in support for [hsync](https://hsync.tech). Configure in Admin UI → Settings → hsync.

### Cloudflare Tunnel

Quick free tunnel:
```bash
cloudflared tunnel --url http://localhost:3050
```

For persistent tunnels, create a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/).

## Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name agentgate.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3050;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set `BASE_URL` for OAuth callbacks:
```bash
BASE_URL=https://agentgate.yourdomain.com npm start
```
